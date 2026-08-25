package com.muroch.frcamera

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.View

/**
 * Face-positioning guide over the camera preview: dimmed surround with a clear
 * oval "stand here" window + bright outline, two steady hint lines, and a
 * BLINKING green up-arrow between the text and the oval that directs the
 * visitor's eye up into the frame.
 *   "Hello Visitor 😊"            (steady, big)
 *   ▲ blinking up-arrow → oval
 *   "Align your face in the frame" (steady)
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
    private val arrow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#4CD964"); style = Paint.Style.STROKE
        strokeWidth = dp(7f); strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val greet = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textAlign = Paint.Align.CENTER; textSize = sp(30f)
        isFakeBoldText = true
    }
    private val hint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textAlign = Paint.Align.CENTER; textSize = sp(23f)
    }

    private var oval = RectF()
    var greetText: String = "Hello Visitor 😊"
    var hintText: String = "Align your face in the frame"

    // Blink the arrow (~600 ms on / off).
    private val ui = Handler(Looper.getMainLooper())
    private var arrowOn = true
    private val blink = object : Runnable {
        override fun run() { arrowOn = !arrowOn; invalidate(); ui.postDelayed(this, 600) }
    }

    // SOFTWARE layer: PorterDuff.CLEAR punches the oval hole AND invalidate()
    // re-renders (a hardware layer cached the view and ignored the blink).
    init { setLayerType(LAYER_TYPE_SOFTWARE, null) }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); ui.postDelayed(blink, 600) }
    override fun onDetachedFromWindow() { super.onDetachedFromWindow(); ui.removeCallbacks(blink) }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        val ovalW = w * 0.66f
        val ovalH = ovalW * 1.28f            // face is taller than wide
        val cx = w / 2f
        val cy = h * 0.42f                    // upper-centre
        oval = RectF(cx - ovalW / 2, cy - ovalH / 2, cx + ovalW / 2, cy + ovalH / 2)
    }

    override fun onDraw(canvas: Canvas) {
        val layer = canvas.saveLayer(0f, 0f, width.toFloat(), height.toFloat(), null)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), mask)
        canvas.drawOval(oval, clear)
        canvas.restoreToCount(layer)
        canvas.drawOval(oval, outline)

        // blinking up-arrow just below the oval, pointing INTO it
        if (arrowOn) drawUpArrow(canvas, width / 2f, oval.bottom + sp(66f))

        // steady text block, ~4 rows below the oval
        val gy = oval.bottom + sp(160f)
        canvas.drawText(greetText, width / 2f, gy, greet)
        canvas.drawText(hintText, width / 2f, gy + sp(46f), hint)
    }

    /** Up-arrow: head near the oval (top), stem below. */
    private fun drawUpArrow(c: Canvas, cx: Float, baseY: Float) {
        val len = sp(42f); val hw = sp(24f); val hh = sp(26f)
        val top = baseY - len
        c.drawLine(cx, baseY, cx, top, arrow)          // stem
        c.drawLine(cx, top, cx - hw, top + hh, arrow)  // head left
        c.drawLine(cx, top, cx + hw, top + hh, arrow)  // head right
    }

    /** Change the oval + arrow colour (e.g. from the FR status later). */
    fun setFrameColor(color: Int) { outline.color = color; arrow.color = color; invalidate() }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun sp(v: Float) = v * resources.displayMetrics.scaledDensity
}
