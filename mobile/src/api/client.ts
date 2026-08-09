import axios, { AxiosError } from 'axios';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Which server this build ships pointed at, from `extra.apiBaseUrl` in app.json.
 * This is baked in at build time, so on its own it would mean a full rebuild
 * every time the backend moves — LAN address today, hosted URL tomorrow.
 */
const configured = Constants.expoConfig?.extra?.apiBaseUrl as string | undefined;

if (!configured && __DEV__) {
  console.warn('extra.apiBaseUrl is not set in app.json; falling back to localhost.');
}

/** What the build was compiled with. "Reset" returns here. */
export const CONFIGURED_BASE_URL = configured ?? 'http://localhost:4000/api';

const TOKEN_KEY = 'pos_token';
const BASE_URL_KEY = 'pos_api_base_url';

/**
 * The address actually in use, which may be an override typed on the device.
 * Kept as a module variable rather than read from storage per request: every
 * call would otherwise pay a SecureStore read, and the value changes about
 * twice a year.
 */
let currentBaseUrl = CONFIGURED_BASE_URL;

export function getApiBaseUrl(): string {
  return currentBaseUrl;
}

/** True when the device is pointed somewhere other than the shipped default. */
export function isCustomApiBaseUrl(): boolean {
  return currentBaseUrl !== CONFIGURED_BASE_URL;
}

/** Just the host, for showing in a tight space. */
export function apiBaseUrlHost(url: string = currentBaseUrl): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

/**
 * Turns what someone types on a phone keyboard into a usable base URL, or
 * throws with something worth showing them.
 *
 * Deliberately forgiving in two ways, because both mistakes are near-certain on
 * a touch keyboard: a missing scheme becomes `https://`, and a bare host gains
 * the `/api` prefix that every route on this server lives under. Written with
 * regexes rather than `new URL()` — React Native's URL implementation is a
 * partial polyfill and not worth trusting for validation.
 */
export function normalizeApiBaseUrl(input: string): string {
  let value = input.trim();
  if (!value) throw new Error('Enter a server address.');

  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, '');

  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(value)) {
    throw new Error("That doesn't look like a valid address.");
  }

  // Host with no path at all: they meant the API root.
  if (/^https?:\/\/[^\s/?#]+$/i.test(value)) value = `${value}/api`;

  return value;
}

/**
 * Load any saved override. Must finish before the first request goes out —
 * the root layout awaits this, so nothing renders against the wrong server.
 */
export async function restoreApiBaseUrl(): Promise<string> {
  try {
    const saved = await SecureStore.getItemAsync(BASE_URL_KEY);
    if (saved) {
      currentBaseUrl = saved;
      api.defaults.baseURL = saved;
    }
  } catch {
    // A corrupt or unreadable override must not stop the app booting; the
    // build's own address is a perfectly good fallback.
  }
  return currentBaseUrl;
}

/** Point the app at a different server, and remember it across restarts. */
export async function setApiBaseUrl(input: string): Promise<string> {
  const next = normalizeApiBaseUrl(input);
  await SecureStore.setItemAsync(BASE_URL_KEY, next);
  currentBaseUrl = next;
  api.defaults.baseURL = next;
  return next;
}

/** Forget the override and go back to what the build shipped with. */
export async function resetApiBaseUrl(): Promise<string> {
  await SecureStore.deleteItemAsync(BASE_URL_KEY);
  currentBaseUrl = CONFIGURED_BASE_URL;
  api.defaults.baseURL = CONFIGURED_BASE_URL;
  return currentBaseUrl;
}

/**
 * Token lives in SecureStore (Android Keystore), not AsyncStorage — it is a
 * long-lived credential and the device may be shared between shift staff.
 */
export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export const api = axios.create({
  baseURL: CONFIGURED_BASE_URL,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Set by the root layout so a 401 can bounce the user to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    if (error.response?.status === 401) {
      await clearToken();
      onUnauthorized?.();
    }
    return Promise.reject(error);
  }
);

/** Turns an axios failure into something worth showing a cashier. */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { detail?: string; message?: string } | undefined;
    if (data?.detail) return data.detail;
    if (data?.message) return data.message;
    if (error.code === 'ECONNABORTED') return 'The server took too long to respond.';
    if (!error.response) return 'No connection to the server.';
    return `Request failed (${error.response.status}).`;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * The parsed body of a failed response, for the few endpoints that answer with
 * more than a message — the bulk stock upload returns the line numbers it could
 * not read. Returns null unless the status matches, so a caller cannot mistake
 * an ordinary failure for a structured one.
 */
export function errorBodyIfStatus<T>(error: unknown, status: number): T | null {
  if (!axios.isAxiosError(error)) return null;
  if (error.response?.status !== status) return null;
  return (error.response.data as T) ?? null;
}

/** True when the failure is a lost/absent network rather than a server refusal. */
export function isNetworkError(error: unknown): boolean {
  return axios.isAxiosError(error) && !error.response;
}

/**
 * True when the sign-in was refused because another handset already holds the
 * account. Matched on the code, not the status: 409 is a generic conflict and
 * other routes use it for their own reasons.
 */
export function isDeviceConflict(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 409 &&
    (error.response.data as { code?: string } | undefined)?.code === 'DEVICE_ALREADY_ACTIVE'
  );
}

/** True when the server answered "that row isn't here" rather than failing. */
export function isNotFound(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404;
}
