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
 * "swipe-up" CHEVRON stack between the text and the oval whose highlight
 * animates UPWARD (bottom → top) to draw the visitor's eye into the frame.
 *   "Hello Visitor 😊"            (steady, big)
 *   ⌃ ⌃ ⌃  chevrons, highlight moving up → oval
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
    private val chevron = Paint(Paint.ANTI_ALIAS_FLAG).apply {
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

    private val CHEVRONS = 3
    private var step = 0                    // which chevron is highlighted (advances → up)
    private val ui = Handler(Looper.getMainLooper())
    private val anim = object : Runnable {
        override fun run() { step = (step + 1) % CHEVRONS; invalidate(); ui.postDelayed(this, 260) }
    }

    // SOFTWARE layer: PorterDuff.CLEAR punches the oval hole AND invalidate()
    // re-renders (a hardware layer cached the view and ignored the animation).
    init { setLayerType(LAYER_TYPE_SOFTWARE, null) }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); ui.postDelayed(anim, 260) }
    override fun onDetachedFromWindow() { super.onDetachedFromWindow(); ui.removeCallbacks(anim) }

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

        drawChevrons(canvas, width / 2f, oval.bottom + sp(46f))

        val gy = oval.bottom + sp(168f)
        canvas.drawText(greetText, width / 2f, gy, greet)
        canvas.drawText(hintText, width / 2f, gy + sp(46f), hint)
    }

    /** 3 up-chevrons stacked below the oval; the highlight moves UP toward it. */
    private fun drawChevrons(c: Canvas, cx: Float, topY: Float) {
        val gap = sp(24f)     // vertical spacing
        val hw = sp(26f)      // half-width
        val hh = sp(17f)      // depth
        for (i in 0 until CHEVRONS) {         // i = 0 top (near oval) … CHEVRONS-1 bottom
            val activeIndex = (CHEVRONS - 1) - step   // step advances → highlight climbs up
            chevron.alpha = if (i == activeIndex) 255 else 70
            val y = topY + i * gap
            c.drawLine(cx - hw, y + hh, cx, y, chevron)   // ⌃ left arm
            c.drawLine(cx, y, cx + hw, y + hh, chevron)   // ⌃ right arm
        }
    }

    /** Change the oval + chevron colour (e.g. from the FR status later). */
    fun setFrameColor(color: Int) { outline.color = color; chevron.color = color; invalidate() }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun sp(v: Float) = v * resources.displayMetrics.scaledDensity
}
