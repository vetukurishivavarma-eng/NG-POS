import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, login, PASSWORD, seedWorld, type World } from './fixtures.js';

/**
 * The reset code never leaves the server in the response, so these tests read
 * it the only other way it exists: the row's hash is bcrypt, so instead of
 * recovering the code we assert on what the flow *does* with it, and take the
 * plaintext from the mail the mailer was asked to send.
 */
const sentMail: { to: string; subject: string; text: string }[] = [];

vi.mock('../src/lib/mailer.js', () => ({
  sendMail: async (mail: { to: string; subject: string; text: string }) => {
    sentMail.push(mail);
    return { sent: true };
  },
}));

// The endpoint refuses to do anything unless a real destination is configured.
vi.mock('../src/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    env: { ...actual.env, PASSWORD_RESET_NOTIFY_EMAIL: 'owner@example.com' },
    passwordResetConfigured: true,
  };
});

function codeFromLastMail(): string {
  const text = sentMail.at(-1)?.text ?? '';
  const match = /One-time code: ([A-Z2-9]+)/.exec(text);
  if (!match) throw new Error(`No code in mail:\n${text}`);
  return match[1]!;
}

describe('forgotten passwords', () => {
  let app: Express;
  let world: World;

  beforeEach(async () => {
    sentMail.length = 0;
    app = api();
    world = await seedWorld(app);
  });

  const forgot = (email: string) => request(app).post('/api/auth/forgot-password').send({ email });

  const reset = (email: string, code: string, new_password: string) =>
    request(app).post('/api/auth/reset-password').send({ email, code, new_password });

  it('mails the administrator, not the address that asked', async () => {
    const res = await forgot(world.emails.cashier);

    expect(res.status).toBe(200);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]!.to).toBe('owner@example.com');
    expect(sentMail[0]!.to).not.toBe(world.emails.cashier);
    // The mail must identify who is asking, or the admin cannot judge it.
    expect(sentMail[0]!.text).toContain(world.emails.cashier);
  });

  // Anti-enumeration was traded away deliberately: staff are sent to a code
  // screen they can never satisfy otherwise. Rate limiting is what now keeps
  // bulk probing impractical, so the wording here is meant to be unambiguous.
  it('says plainly that an unknown address has no account, and mails nobody', async () => {
    const real = await forgot(world.emails.cashier);
    const fake = await forgot('nobody-at-all@test.local');

    expect(real.status).toBe(200);
    expect(fake.status).toBe(404);
    expect(fake.body.detail).toMatch(/no account exists/i);
    expect(sentMail).toHaveLength(1);
  });

  it('never puts the code in the HTTP response', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    const res = await forgot(world.emails.manager);
    expect(JSON.stringify(res.body)).not.toContain(code);
    expect(JSON.stringify(res.body)).not.toContain(codeFromLastMail());
  });

  it('stores the code hashed, never in plaintext', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    const row = await prisma.passwordResetRequest.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    expect(row.codeHash).not.toBe(code);
    expect(await bcrypt.compare(code, row.codeHash)).toBe(true);
  });

  it('resets the password with a valid code', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    const res = await reset(world.emails.cashier, code, 'BrandNewPass1!');
    expect(res.status).toBe(200);

    await expect(login(app, world.emails.cashier, 'BrandNewPass1!')).resolves.toBeTruthy();
    await expect(login(app, world.emails.cashier, PASSWORD)).rejects.toThrow();
  });

  it('accepts the code in lower case and with stray spaces', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    const res = await reset(world.emails.cashier, ` ${code.toLowerCase()} `, 'BrandNewPass1!');
    expect(res.status).toBe(200);
  });

  it('refuses to reuse a code', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    expect((await reset(world.emails.cashier, code, 'BrandNewPass1!')).status).toBe(200);
    expect((await reset(world.emails.cashier, code, 'AnotherPass1!')).status).toBe(400);
  });

  it("refuses another account's code", async () => {
    await forgot(world.emails.cashier);
    const cashierCode = codeFromLastMail();

    const res = await reset(world.emails.manager, cashierCode, 'BrandNewPass1!');
    expect(res.status).toBe(400);
    await expect(login(app, world.emails.manager, PASSWORD)).resolves.toBeTruthy();
  });

  it('invalidates the previous code when a new one is requested', async () => {
    await forgot(world.emails.cashier);
    const first = codeFromLastMail();
    await forgot(world.emails.cashier);
    const second = codeFromLastMail();

    expect((await reset(world.emails.cashier, first, 'BrandNewPass1!')).status).toBe(400);
    expect((await reset(world.emails.cashier, second, 'BrandNewPass1!')).status).toBe(200);
  });

  it('rejects an expired code', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    await prisma.passwordResetRequest.updateMany({
      where: { consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await reset(world.emails.cashier, code, 'BrandNewPass1!')).status).toBe(400);
  });

  it('burns the code after repeated wrong guesses', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    for (let i = 0; i < 5; i += 1) {
      await reset(world.emails.cashier, 'WRONGGUE', 'BrandNewPass1!');
    }

    // Even the *correct* code is dead now — that is the point.
    expect((await reset(world.emails.cashier, code, 'BrandNewPass1!')).status).toBe(400);
  });

  it('enforces the minimum password length', async () => {
    await forgot(world.emails.cashier);
    const code = codeFromLastMail();

    // 422 rather than 400: schema violations are answered by the shared zod
    // handler, before the route's own "bad code" path is reached.
    expect((await reset(world.emails.cashier, code, 'short')).status).toBe(422);
    await expect(login(app, world.emails.cashier, PASSWORD)).resolves.toBeTruthy();
  });

  it('signs out sessions that predate the reset', async () => {
    const token = world.tokens.cashier;
    expect(
      (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status
    ).toBe(200);

    // A JWT's `iat` has one-second resolution, so a token minted in the same
    // second as the reset is deliberately still honoured. Cross the boundary so
    // this asserts the rule rather than the clock.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await forgot(world.emails.cashier);
    await reset(world.emails.cashier, codeFromLastMail(), 'BrandNewPass1!');

    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});
