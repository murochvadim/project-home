package com.muroch.frcamera

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View

/**
 * Face-positioning guide drawn over the camera preview: the whole view is
 * dimmed EXCEPT a clear oval "stand here" window, with a bright outline + a
 * hint line. The person aligns their face inside the oval → consistent framing
 * → better recognition. Static (drawn once); the outline colour can later be
 * driven by the FR status (green=welcome / red=denied).
 */
class FaceFrameView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : View(context, attrs) {

    private val mask = Paint().apply { color = 0x99000000.toInt() }          // dim surround
    private val clear = Paint(Paint.ANTI_ALIAS_FLAG).apply {                 // punch the oval hole
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#4CD964"); style = Paint.Style.STROKE
        strokeWidth = dp(3.5f)
    }
    private val hint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textAlign = Paint.Align.CENTER; textSize = sp(16f)
    }

    private var oval = RectF()
    var hintText: String = "Align your face in the frame"

    init { setLayerType(LAYER_TYPE_HARDWARE, null) }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        val ovalW = w * 0.66f
        val ovalH = ovalW * 1.28f            // face is taller than wide
        val cx = w / 2f
        val cy = h * 0.42f                    // upper-centre; hint + status sit below
        oval = RectF(cx - ovalW / 2, cy - ovalH / 2, cx + ovalW / 2, cy + ovalH / 2)
    }

    override fun onDraw(canvas: Canvas) {
        val layer = canvas.saveLayer(0f, 0f, width.toFloat(), height.toFloat(), null)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), mask)
        canvas.drawOval(oval, clear)
        canvas.restoreToCount(layer)
        canvas.drawOval(oval, outline)
        canvas.drawText(hintText, width / 2f, oval.bottom + sp(40f), hint)
    }

    /** Change the oval colour (e.g. from the FR status later). */
    fun setFrameColor(color: Int) { outline.color = color; invalidate() }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun sp(v: Float) = v * resources.displayMetrics.scaledDensity
}
