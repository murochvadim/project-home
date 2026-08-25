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
 * Face-positioning guide + FR-result screen. ONE view, four states (setState):
 *   IDLE    🟢  "Hello Visitor 😊" / "Align your face in the frame" + swipe-up chevrons
 *   ALLOWED 🟢  "Welcome, <name>!" / "Opening the door…"
 *   DENIED  🟠  "Welcome, <name>"  / "The owner will open the door for you."
 *   UNKNOWN 🔵  "Please wait…"      / ""
 * The camera + oval stay live; only the colour + text change. Later the state
 * is driven by the FR backend (LXC 112) over MQTT; for now via an adb broadcast.
 */
class FaceFrameView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : View(context, attrs) {

    enum class St { IDLE, ALLOWED, DENIED, UNKNOWN }

    // Settable sentences ({name} is substituted). Change here or later via settings.
    var idleGreet    = "Hello Visitor 😊"
    var idleHint     = "Align your face in the frame"
    var allowedGreet = "Welcome, {name}!"
    var allowedHint  = "Opening the door…"
    var deniedGreet  = "Welcome, {name}"
    var deniedHint   = "The owner will open the door for you."
    var unknownGreet = "Please wait…"
    var unknownHint  = ""

    private val GREEN = Color.parseColor("#4CD964")
    private val AMBER = Color.parseColor("#FF9F0A")
    private val BLUE  = Color.parseColor("#5AC8FA")

    private val mask = Paint().apply { color = 0x99000000.toInt() }
    private val clear = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = GREEN; style = Paint.Style.STROKE; strokeWidth = dp(3.5f)
    }
    private val chevron = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = GREEN; style = Paint.Style.STROKE
        strokeWidth = dp(7f); strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val greet = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textAlign = Paint.Align.CENTER; textSize = sp(30f); isFakeBoldText = true
    }
    private val hint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textAlign = Paint.Align.CENTER; textSize = sp(23f)
    }

    private var oval = RectF()
    private var state = St.IDLE
    private var line1 = idleGreet
    private var line2 = idleHint

    private val CHEVRONS = 3
    private var step = 0
    private val ui = Handler(Looper.getMainLooper())
    private val anim = object : Runnable {
        override fun run() { step = (step + 1) % CHEVRONS; invalidate(); ui.postDelayed(this, 260) }
    }

    init { setLayerType(LAYER_TYPE_SOFTWARE, null) }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); ui.postDelayed(anim, 260) }
    override fun onDetachedFromWindow() { super.onDetachedFromWindow(); ui.removeCallbacks(anim) }

    /** Set the recognition state (+ person name for ALLOWED/DENIED). */
    fun setState(s: St, name: String = "") {
        state = s
        val col: Int
        when (s) {
            St.IDLE    -> { line1 = idleGreet; line2 = idleHint; col = GREEN }
            St.ALLOWED -> { line1 = allowedGreet.replace("{name}", name); line2 = allowedHint; col = GREEN }
            St.DENIED  -> { line1 = deniedGreet.replace("{name}", name); line2 = deniedHint; col = AMBER }
            St.UNKNOWN -> { line1 = unknownGreet; line2 = unknownHint; col = BLUE }
        }
        outline.color = col; chevron.color = col
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        val ovalW = w * 0.66f
        val ovalH = ovalW * 1.28f
        val cx = w / 2f
        val cy = h * 0.42f
        oval = RectF(cx - ovalW / 2, cy - ovalH / 2, cx + ovalW / 2, cy + ovalH / 2)
    }

    override fun onDraw(canvas: Canvas) {
        val layer = canvas.saveLayer(0f, 0f, width.toFloat(), height.toFloat(), null)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), mask)
        canvas.drawOval(oval, clear)
        canvas.restoreToCount(layer)
        canvas.drawOval(oval, outline)

        if (state == St.IDLE) drawChevrons(canvas, width / 2f, oval.bottom + sp(46f))

        val gy = oval.bottom + sp(168f)
        canvas.drawText(line1, width / 2f, gy, greet)
        if (line2.isNotEmpty()) canvas.drawText(line2, width / 2f, gy + sp(46f), hint)
    }

    private fun drawChevrons(c: Canvas, cx: Float, topY: Float) {
        val gap = sp(24f); val hw = sp(26f); val hh = sp(17f)
        for (i in 0 until CHEVRONS) {
            val activeIndex = (CHEVRONS - 1) - step
            chevron.alpha = if (i == activeIndex) 255 else 70
            val y = topY + i * gap
            c.drawLine(cx - hw, y + hh, cx, y, chevron)
            c.drawLine(cx, y, cx + hw, y + hh, chevron)
        }
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun sp(v: Float) = v * resources.displayMetrics.scaledDensity
}
