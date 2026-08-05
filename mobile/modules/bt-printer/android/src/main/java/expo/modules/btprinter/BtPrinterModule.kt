package expo.modules.btprinter

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.util.UUID

/** Serial Port Profile — the RFCOMM service every ESC/POS thermal printer exposes. */
private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

/**
 * Cheap printers have small input buffers. Writing a whole receipt in one go
 * overruns them and produces truncated or garbled output, so we feed the socket
 * in chunks and let the printer drain between them.
 */
private const val CHUNK_SIZE = 256
private const val CHUNK_PAUSE_MS = 20L

class BluetoothUnavailableException :
  CodedException("ERR_BT_UNAVAILABLE", "This device has no Bluetooth adapter.", null)

class BluetoothDisabledException :
  CodedException("ERR_BT_DISABLED", "Bluetooth is turned off.", null)

class BluetoothPermissionException :
  CodedException(
    "ERR_BT_PERMISSION",
    "Bluetooth permission has not been granted.",
    null
  )

class PrinterNotFoundException(address: String) :
  CodedException("ERR_PRINTER_NOT_FOUND", "No paired printer with address $address.", null)

class PrinterConnectionException(message: String, cause: Throwable?) :
  CodedException("ERR_PRINTER_CONNECT", message, cause)

class BtPrinterModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw BluetoothUnavailableException()

  private val adapter: BluetoothAdapter?
    get() {
      val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      return manager?.adapter
    }

  override fun definition() = ModuleDefinition {
    Name("BtPrinter")

    Function("isSupported") {
      adapter != null
    }

    Function("isEnabled") {
      adapter?.isEnabled == true
    }

    Function("hasPermission") {
      hasConnectPermission()
    }

    /** Paired devices only — pairing itself stays in Android's system UI. */
    AsyncFunction("getPairedDevices") {
      requireReady()
      val devices = adapter?.bondedDevices ?: emptySet<BluetoothDevice>()
      devices.map { device ->
        mapOf(
          "name" to (device.name ?: "Unknown device"),
          "address" to device.address,
          "isLikelyPrinter" to isLikelyPrinter(device)
        )
      }
    }

    /**
     * Sends raw ESC/POS bytes. The receipt is composed in TypeScript and passed
     * here base64-encoded so binary control codes survive the JS bridge intact.
     */
    AsyncFunction("printBase64") { address: String, base64Data: String ->
      requireReady()

      val device = adapter?.bondedDevices?.firstOrNull { it.address == address }
        ?: throw PrinterNotFoundException(address)

      val bytes = Base64.decode(base64Data, Base64.DEFAULT)
      writeToDevice(device, bytes)
      true
    }

    /** Connect and disconnect without printing, to verify a printer is reachable. */
    AsyncFunction("testConnection") { address: String ->
      requireReady()

      val device = adapter?.bondedDevices?.firstOrNull { it.address == address }
        ?: throw PrinterNotFoundException(address)

      val socket = openSocket(device)
      try {
        socket.close()
      } catch (_: IOException) {
        // Already closed; nothing useful to do.
      }
      true
    }
  }

  private fun requireReady() {
    if (adapter == null) throw BluetoothUnavailableException()
    if (!hasConnectPermission()) throw BluetoothPermissionException()
    if (adapter?.isEnabled != true) throw BluetoothDisabledException()
  }

  private fun hasConnectPermission(): Boolean {
    // BLUETOOTH_CONNECT only exists from Android 12; below that the legacy
    // manifest permissions are granted at install time.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.BLUETOOTH_CONNECT
    ) == PackageManager.PERMISSION_GRANTED
  }

  private fun writeToDevice(device: BluetoothDevice, bytes: ByteArray) {
    var socket: BluetoothSocket? = null
    try {
      socket = openSocket(device)
      val out = socket.outputStream

      var offset = 0
      while (offset < bytes.size) {
        val end = minOf(offset + CHUNK_SIZE, bytes.size)
        out.write(bytes, offset, end - offset)
        out.flush()
        offset = end
        if (offset < bytes.size) Thread.sleep(CHUNK_PAUSE_MS)
      }

      // Give the print head time to consume the buffer before we drop the link;
      // closing too early truncates the tail of the receipt.
      Thread.sleep(300)
    } catch (e: IOException) {
      throw PrinterConnectionException(e.message ?: "Failed to write to printer.", e)
    } catch (e: SecurityException) {
      throw BluetoothPermissionException()
    } finally {
      try {
        socket?.close()
      } catch (_: IOException) {
        // Nothing to recover here.
      }
    }
  }

  private fun openSocket(device: BluetoothDevice): BluetoothSocket {
    // Discovery and RFCOMM connection contend for the same radio.
    try {
      adapter?.cancelDiscovery()
    } catch (_: SecurityException) {
      // Non-fatal: connecting may still succeed.
    }

    try {
      val socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
      socket.connect()
      return socket
    } catch (primary: IOException) {
      // Widespread quirk in low-cost printers: the SDP record is missing or
      // wrong, and the documented call fails. The hidden channel-1 constructor
      // is the long-standing workaround and is what most printers respond to.
      try {
        val fallback = device.javaClass
          .getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
          .invoke(device, 1) as BluetoothSocket
        fallback.connect()
        return fallback
      } catch (secondary: Exception) {
        throw PrinterConnectionException(
          "Could not connect to ${device.name ?: device.address}. " +
            "Check the printer is on, in range, and paired.",
          primary
        )
      }
    } catch (e: SecurityException) {
      throw BluetoothPermissionException()
    }
  }

  /** Best-effort hint so the picker can surface printers above headsets. */
  private fun isLikelyPrinter(device: BluetoothDevice): Boolean {
    return try {
      val major = device.bluetoothClass?.majorDeviceClass
      val name = (device.name ?: "").lowercase()
      major == android.bluetooth.BluetoothClass.Device.Major.IMAGING ||
        listOf("print", "pos", "rp", "mtp", "tp-", "escpos", "thermal")
          .any { name.contains(it) }
    } catch (_: SecurityException) {
      false
    }
  }
}
