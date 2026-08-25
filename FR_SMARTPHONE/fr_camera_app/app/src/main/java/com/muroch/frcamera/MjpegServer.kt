package com.muroch.frcamera

import fi.iki.elonen.NanoHTTPD
import java.io.InputStream

/**
 * Minimal MJPEG (motion-JPEG) HTTP server for go2rtc / a browser to pull.
 *
 * GET / (any path) → an endless `multipart/x-mixed-replace` stream of the
 * latest JPEG frame. `frameSource` returns the most recent JPEG the camera
 * produced (null until the first frame). Rate-capped to ~15 fps.
 *
 * Open `http://<phone-ip>:8080/` in a browser to see it live, or point
 * go2rtc at it as an `mjpeg` source (phone_entrance_cam).
 */
class MjpegServer(port: Int, private val frameSource: () -> ByteArray?) : NanoHTTPD(port) {

    private val boundary = "frameboundary"

    override fun serve(session: IHTTPSession): Response {
        val body = object : InputStream() {
            private var buf = ByteArray(0)
            private var pos = 0

            // Wait for a frame, then wrap it as one multipart part.
            private fun fill() {
                var jpeg = frameSource()
                var tries = 0
                while (jpeg == null && tries < 150) { Thread.sleep(20); jpeg = frameSource(); tries++ }
                val j = jpeg ?: ByteArray(0)
                val head = "--$boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${j.size}\r\n\r\n".toByteArray()
                buf = head + j + "\r\n".toByteArray()
                pos = 0
            }

            override fun read(): Int {
                if (pos >= buf.size) { Thread.sleep(66); fill() }
                return buf[pos++].toInt() and 0xFF
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (pos >= buf.size) { Thread.sleep(66); fill() }
                val n = minOf(len, buf.size - pos)
                System.arraycopy(buf, pos, b, off, n)
                pos += n
                return n
            }
        }
        return newChunkedResponse(Response.Status.OK, "multipart/x-mixed-replace; boundary=$boundary", body)
    }
}
