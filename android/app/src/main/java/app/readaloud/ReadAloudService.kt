package app.readaloud

import android.accessibilityservice.AccessibilityButtonController
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Reads any app aloud. A floating bubble toggles sticky pick mode (the extension's Alt tap):
 * readable blocks are outlined, tapping one reads from there to the end of the page, and the
 * mode stays up so you can jump around; drags are replayed to the app so you can still scroll.
 * Text selection menus get "Read aloud" / "Read from here" (ProcessTextActivity).
 */
class ReadAloudService : AccessibilityService(), Player.Listener {
    private lateinit var prefs: Prefs
    private lateinit var player: Player
    private lateinit var cache: AudioCache
    private lateinit var wm: WindowManager
    private val main = Handler(Looper.getMainLooper())
    private val bg = Executors.newSingleThreadExecutor()

    private var layer: LayerView? = null
    private var bubble: TextView? = null
    private var pill: LinearLayout? = null
    private var pillStatus: TextView? = null
    private var pillVoice: TextView? = null
    private var pillRate: TextView? = null
    private var pillPause: TextView? = null

    // pick mode
    private var picking = false
    private var pickPage: Page? = null
    private var pickRects: List<Pair<Rect, Boolean>> = emptyList() // block bounds, isImage
    private var pressed = -1

    // reading
    private var readPage: Page? = null
    private var segs: MutableList<Page.Seg> = mutableListOf()
    private var curSeg: Page.Seg? = null
    private var curLines: List<RectF> = emptyList()
    private var curChars: List<Pair<Int, RectF?>> = emptyList()
    private var curWords: List<IntArray> = emptyList() // [docStart, docEnd, cumulative weight end]
    private var rectsDirty = true
    private var imageRect: RectF? = null
    private var lastShowOnScreen = 0L

    override fun onServiceConnected() {
        instance = this
        prefs = Prefs(this)
        cache = AudioCache(cacheDir)
        Player.tmpDir = cacheDir
        player = Player(cache, this)
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        addLayer()
        if (prefs.bubble) addBubble()
        accessibilityButtonController.registerAccessibilityButtonCallback(object : AccessibilityButtonController.AccessibilityButtonCallback() {
            override fun onClicked(controller: AccessibilityButtonController) = togglePick()
        })
        if (BuildConfig.DEBUG) registerDebug()
        Log.i(TAG, "service connected")
    }

    override fun onDestroy() {
        instance = null
        player.stop(silent = true)
        listOf(layer, bubble, pill).forEach { v -> v?.let { runCatching { wm.removeView(it) } } }
        super.onDestroy()
    }

    override fun onInterrupt() {}

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        if (e.packageName?.toString() == packageName) return
        when (e.eventType) {
            AccessibilityEvent.TYPE_VIEW_SCROLLED, AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                rectsDirty = true
                if (picking) schedulePickIndex()
            }
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                rectsDirty = true
                if (picking) schedulePickIndex(300)
            }
        }
    }

    // ---- page ---------------------------------------------------------------------------

    private fun appRoot(): AccessibilityNodeInfo? {
        val r = rootInActiveWindow
        if (r != null && r.packageName?.toString() != packageName) return r
        // our own activity (selection menu) may still be on top: use the app window under it
        return windows.filter { it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION }
            .mapNotNull { it.root }.firstOrNull { it.packageName?.toString() != packageName }
    }

    private fun buildPage(): Page? {
        val root = appRoot() ?: return null
        val t0 = SystemClock.uptimeMillis()
        val p = Page.build(root, resources.displayMetrics.widthPixels, packageName)
        Log.i(TAG, "page ${root.packageName}: ${p?.blocks?.size ?: 0} blocks, ${p?.full?.length ?: 0} chars in ${SystemClock.uptimeMillis() - t0} ms")
        return p
    }

    // ---- pick mode ----------------------------------------------------------------------

    fun togglePick() = if (picking) endPick() else startPick()

    fun startPick() {
        picking = true
        pickIndex()
        setLayerTouchable(true)
        updateBubble()
    }

    fun endPick() {
        picking = false
        pickRects = emptyList(); pickPage = null; pressed = -1
        setLayerTouchable(false)
        updateBubble()
        layer?.invalidate()
    }

    private val pickIndexRun = Runnable { if (picking) pickIndex() }
    private fun schedulePickIndex(delay: Long = 250) {
        main.removeCallbacks(pickIndexRun)
        main.postDelayed(pickIndexRun, delay)
    }

    private fun pickIndex() {
        val p = buildPage()
        pickPage = p
        val h = resources.displayMetrics.heightPixels
        pickRects = p?.blocks?.map { b -> b.bounds() to b.image }?.map { (r, img) ->
            if (r.bottom < 0 || r.top > h) Rect() to img else r to img
        } ?: emptyList()
        layer?.invalidate()
    }

    private fun blockAtPick(x: Int, y: Int): Int {
        var best = -1; var area = Long.MAX_VALUE
        for ((i, pr) in pickRects.withIndex()) {
            val r = pr.first
            if (!r.isEmpty && r.contains(x, y) && r.width().toLong() * r.height() < area) { best = i; area = r.width().toLong() * r.height() }
        }
        return best
    }

    // ---- reading ------------------------------------------------------------------------

    fun readFromBlock(page: Page, block: Int) {
        readPage = page
        startSegs(page.segsFrom(block))
    }

    /** Selection menu: "Read aloud" (just the selection) or "Read from here" (to the end). */
    fun readSelection(text: String, fromHere: Boolean, tries: Int = 0) {
        val page = buildPage()
        if (page == null) {
            if (tries < 4) { main.postDelayed({ readSelection(text, fromHere, tries + 1) }, 250); return }
            readPage = null
            startSegs(Text.segments(text).map { Page.Seg(-1, -1, Text.clean(text.substring(it.start, it.end)), null, 0) })
            return
        }
        val needle = Text.clean(text)
        // where the selection really is (a common word appears many times): ask the app, else search
        var at = page.leaves.firstNotNullOfOrNull { l ->
            val s = l.node.textSelectionStart
            if (s < 0 || l.node.textSelectionEnd <= s) null
            else (l.node.text?.toString() ?: "").let { raw -> l.start + (s - raw.indexOf(l.text.take(20)).coerceAtLeast(0)) }
                .takeIf { page.full.startsWith(needle.take(12), it) }
        } ?: page.full.indexOf(needle)
        if (at < 0) at = page.full.indexOf(needle.take(24))
        readPage = page
        when {
            // from the sentence holding the selection to the end of the page
            at >= 0 && fromHere -> startSegs(page.segsFrom(page.blockAt(at)).dropWhile { it.image == null && it.end <= at })
            at >= 0 -> {
                // just the selected range, mapped onto the page for highlighting
                val end = at + needle.length
                startSegs(Text.segments(page.full.substring(at, end)).map {
                    Page.Seg(at + it.start, at + it.end, Text.clean(page.full.substring(at + it.start, at + it.end)), null, page.blockAt(at + it.start))
                })
            }
            else -> { // not found on the page (another app's selection): read it without highlights
                readPage = null
                startSegs(Text.segments(text).map { Page.Seg(-1, -1, Text.clean(text.substring(it.start, it.end)), null, 0) })
            }
        }
    }

    private fun startSegs(list: List<Page.Seg>) {
        if (list.isEmpty()) { toast("Nothing readable here"); return }
        segs = list.toMutableList()
        val rules = Text.parseLex(prefs.lex)
        val items = segs.map { s -> Player.Item(s.text?.let { Text.lex(it, rules, prefs.autoAcronyms) }, s, image = s.image != null) }
        Log.i(TAG, "read ${items.size} items: " + items.take(12).joinToString(" | ") { it.text ?: "[image]" })
        showPill()
        player.play(items, prefs.server(), prefs.voice, prefs.steps, prefs.rate, prefs.cache)
        startTicker()
    }

    override fun onLoading(index: Int, total: Int) { setSeg(index); pillStatus?.text = "…${index + 1}/$total" }
    override fun onPlaying(index: Int, total: Int) {
        setSeg(index)
        pillStatus?.text = "${index + 1}/$total"
        Log.i(TAG, "speak[$index]: ${player.items.getOrNull(index)?.text}")
    }
    override fun onPaused(paused: Boolean) { pillPause?.text = if (paused) "▶" else "❚❚" }
    override fun onError(message: String) { pillStatus?.text = "error"; toast(message) }
    override fun onDone() { curSeg = null; imageRect = null; hidePill(); layer?.invalidate() }

    private fun setSeg(i: Int) {
        val s = player.items.getOrNull(i)?.tag as? Page.Seg ?: return
        if (s === curSeg) return
        curSeg = s
        rectsDirty = true
        val page = readPage
        curWords = if (page != null && s.start >= 0 && s.image == null) {
            var acc = 0
            Regex("\\S+").findAll(page.full.substring(s.start, s.end)).map { m ->
                val w = m.value
                acc += w.length + (if (w.last() in ",;:") 3 else if (w.last() in ".!?") 5 else 1)
                intArrayOf(s.start + m.range.first, s.start + m.range.last + 1, acc)
            }.toList()
        } else emptyList()
    }

    // ---- images: scroll into view, screenshot, OCR -----------------------------------------

    override fun onNeedImage(index: Int, item: Player.Item) {
        val seg = item.tag as Page.Seg
        val leaf = seg.image
        if (!prefs.ocr || leaf == null) { player.resolve(index, emptyList()); return }
        if (ocrFor === seg) return // already on it
        ocrFor = seg
        curSeg = seg
        pillStatus?.text = "reading image…"
        leaf.node.refresh()
        leaf.node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        main.postDelayed({ ocr(index, seg, leaf) }, 450)
    }

    /** OCR confuses O and 0 inside all-caps words ("0CR"). */
    private fun fixOcr(t: String) = Regex("\\b[A-Z0]*[A-Z][A-Z0]*\\b").replace(t) { it.value.replace('0', 'O') }

    private var ocrFor: Page.Seg? = null

    private fun ocr(index: Int, seg: Page.Seg, leaf: Page.Leaf) {
        leaf.node.refresh()
        val r = Rect(); leaf.node.getBoundsInScreen(r)
        val screen = Rect(0, 0, resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        if (!r.intersect(screen) || r.width() < 40 || r.height() < 40) { player.resolve(index, emptyList()); return }
        imageRect = RectF(r)
        // our overlays must not end up in the screenshot
        layer?.visibility = View.INVISIBLE; pill?.visibility = View.INVISIBLE; bubble?.visibility = View.INVISIBLE
        main.postDelayed({
            takeScreenshot(Display.DEFAULT_DISPLAY, bg, object : TakeScreenshotCallback {
                override fun onSuccess(shot: ScreenshotResult) {
                    val hw = Bitmap.wrapHardwareBuffer(shot.hardwareBuffer, shot.colorSpace)
                    shot.hardwareBuffer.close()
                    main.post { layer?.visibility = View.VISIBLE; pill?.visibility = View.VISIBLE; bubble?.visibility = View.VISIBLE }
                    if (hw == null) { main.post { player.resolve(index, emptyList()) }; return }
                    val sw = hw.copy(Bitmap.Config.ARGB_8888, false)
                    val crop = Bitmap.createBitmap(sw, r.left, r.top, minOf(r.width(), sw.width - r.left), minOf(r.height(), sw.height - r.top))
                    TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).process(InputImage.fromBitmap(crop, 0))
                        .addOnSuccessListener { res ->
                            val text = fixOcr(res.textBlocks.joinToString("\n") { b -> b.lines.joinToString(" ") { it.text } })
                            Log.i(TAG, "ocr ${r.width()}x${r.height()}: $text")
                            val words = text.split(Regex("\\s+")).count { it.length > 1 }
                            if (words < 2) { player.resolve(index, emptyList()); return@addOnSuccessListener }
                            val rules = Text.parseLex(prefs.lex)
                            val flat = text.replace("\n", " ")
                            val items = Text.segments(flat, firstMax = 260).map {
                                val t = Text.clean(flat.substring(it.start, it.end))
                                Player.Item(Text.lex(t, rules, prefs.autoAcronyms), Page.Seg(seg.start, seg.end, t, null, seg.block))
                            }
                            player.resolve(index, items)
                        }
                        .addOnFailureListener { player.resolve(index, emptyList()) }
                }
                override fun onFailure(errorCode: Int) {
                    Log.w(TAG, "screenshot failed $errorCode")
                    main.post {
                        layer?.visibility = View.VISIBLE; pill?.visibility = View.VISIBLE; bubble?.visibility = View.VISIBLE
                        player.resolve(index, emptyList())
                    }
                }
            })
        }, 80)
    }

    // ---- highlight ticker ---------------------------------------------------------------

    private val tick = object : Runnable {
        override fun run() {
            if (!player.active) { layer?.invalidate(); return }
            updateHighlight()
            layer?.invalidate()
            main.postDelayed(this, 50)
        }
    }
    private fun startTicker() { main.removeCallbacks(tick); main.post(tick) }

    private fun updateHighlight() {
        val s = curSeg ?: return
        val page = readPage ?: return
        if (s.start < 0) return
        if (s.image != null) return
        if (rectsDirty) {
            rectsDirty = false
            val chars = ArrayList<Pair<Int, RectF?>>()
            for (l in page.leaves) {
                if (l.end <= s.start || l.start >= s.end || l.image) continue
                val a = maxOf(s.start, l.start) - l.start; val b = minOf(s.end, l.end) - l.start
                val cr = page.charRects(l, a, b)
                if (cr != null) cr.forEachIndexed { k, r -> chars.add(l.start + a + k to r) }
            }
            curChars = chars
            curLines = page.rects(s.start, s.end)
            Log.d(TAG, "rects \"${page.full.substring(s.start, s.end).take(30)}\": ${curLines.size} lines ${curLines.joinToString { it.toShortString() }} chars=${chars.size}")
            imageRect = if (curLines.isEmpty()) null else imageRect
            // follow the reading: bring the sentence on screen if it scrolled away
            val h = resources.displayMetrics.heightPixels
            val visible = curLines.any { it.bottom > 0 && it.top < h }
            if (!visible && SystemClock.uptimeMillis() - lastShowOnScreen > 800) {
                lastShowOnScreen = SystemClock.uptimeMillis()
                page.leaves.firstOrNull { it.end > s.start && !it.image }?.node?.performAction(
                    AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                main.postDelayed({ rectsDirty = true }, 350)
            }
        }
    }

    private fun currentWordRects(): List<RectF> {
        if (curWords.isEmpty() || curChars.isEmpty()) return emptyList()
        val total = curWords.last()[2].toFloat()
        val at = player.progress() * total
        val w = curWords.firstOrNull { it[2] >= at } ?: curWords.last()
        return Page.mergeLines(curChars.filter { it.first >= w[0] && it.first < w[1] }.mapNotNull { it.second })
    }

    // ---- overlay views ------------------------------------------------------------------

    private fun overlayParams(w: Int, h: Int, touchable: Boolean) = WindowManager.LayoutParams(
        w, h, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
    }

    private fun addLayer() {
        val v = LayerView(this)
        layer = v
        wm.addView(v, overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, false))
    }

    private fun setLayerTouchable(t: Boolean) {
        val v = layer ?: return
        val lp = v.layoutParams as WindowManager.LayoutParams
        lp.flags = if (t) lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        else lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        wm.updateViewLayout(v, lp)
    }

    private fun dp(v: Float) = (v * resources.displayMetrics.density).toInt()

    @SuppressLint("ClickableViewAccessibility")
    private fun addBubble() {
        val size = dp(46f)
        val b = TextView(this).apply {
            text = "Aa"; textSize = 15f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
            background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(0xE016161A.toInt()) }
            elevation = dp(4f).toFloat()
            contentDescription = "Read aloud: pick where to read"
        }
        bubble = b
        val lp = overlayParams(size, size, true)
        val sw = resources.displayMetrics.widthPixels
        lp.x = if (prefs.bubbleLeft) 0 else sw - size
        lp.y = if (prefs.bubbleY >= 0) prefs.bubbleY else resources.displayMetrics.heightPixels * 2 / 3
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragging = false; var downAt = 0L
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        b.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; startX = lp.x; startY = lp.y; dragging = false; downAt = SystemClock.uptimeMillis() }
                MotionEvent.ACTION_MOVE -> {
                    if (!dragging && (abs(e.rawX - downX) > slop || abs(e.rawY - downY) > slop)) dragging = true
                    if (dragging) { lp.x = (startX + (e.rawX - downX)).toInt(); lp.y = (startY + (e.rawY - downY)).toInt(); wm.updateViewLayout(b, lp); placePill() }
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        val left = lp.x + size / 2 < sw / 2
                        lp.x = if (left) 0 else sw - size
                        wm.updateViewLayout(b, lp)
                        prefs.bubbleLeft = left; prefs.bubbleY = lp.y
                        placePill()
                    } else if (SystemClock.uptimeMillis() - downAt > 600) {
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } else togglePick()
                }
            }
            true
        }
        wm.addView(b, lp)
    }

    fun setBubbleShown(show: Boolean) {
        if (show && bubble == null) addBubble()
        if (!show) bubble?.let { runCatching { wm.removeView(it) }; bubble = null }
    }

    private fun updateBubble() {
        val b = bubble ?: return
        (b.background as android.graphics.drawable.GradientDrawable).setColor(if (picking) 0xF02F6FEB.toInt() else 0xE016161A.toInt())
        b.text = if (picking) "✕" else "Aa"
    }

    private fun btn(label: String, desc: String, onClick: () -> Unit) = TextView(this).apply {
        text = label; textSize = 15f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
        setPadding(dp(9f), dp(6f), dp(9f), dp(6f)); contentDescription = desc
        setOnClickListener { onClick() }
    }

    private fun showPill() {
        if (pill != null) { refreshPill(); return }
        val p = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = android.graphics.drawable.GradientDrawable().apply { cornerRadius = dp(24f).toFloat(); setColor(0xF016161A.toInt()) }
            setPadding(dp(6f), dp(2f), dp(6f), dp(2f)); elevation = dp(6f).toFloat()
        }
        pillVoice = btn("", "Switch voice") {
            val v = if (prefs.voice == "clark") "baldree" else "clark"
            prefs.voice = v; player.setVoice(v, prefs.server(v)); refreshPill()
        }.apply { setTextColor(0xFF7FB2FF.toInt()) }
        p.addView(pillVoice)
        p.addView(btn("⏮", "Previous sentence") { player.prev() })
        pillPause = btn("❚❚", "Pause or resume") { player.toggle() }
        p.addView(pillPause)
        p.addView(btn("⏭", "Next sentence") { player.next() })
        p.addView(btn("−", "Slower") { player.setRate(player.rate - 0.25f); prefs.rate = player.rate; refreshPill() })
        pillRate = btn("", "Speed") {}
        p.addView(pillRate)
        p.addView(btn("+", "Faster") { player.setRate(player.rate + 0.25f); prefs.rate = player.rate; refreshPill() })
        pillStatus = TextView(this).apply { textSize = 11f; setTextColor(0xFF9AA1AC.toInt()); setPadding(dp(4f), 0, dp(4f), 0) }
        p.addView(pillStatus)
        p.addView(btn("✕", "Stop reading") { player.stop() })
        pill = p
        wm.addView(p, overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, true))
        refreshPill()
        p.post { placePill() }
    }

    private fun refreshPill() {
        pillVoice?.text = Prefs.NAMES[prefs.voice] ?: prefs.voice
        pillRate?.text = "${"%.2f".format(player.rate).trimEnd('0').trimEnd('.')}×"
        pillPause?.text = if (player.paused) "▶" else "❚❚"
    }

    private fun placePill() {
        val p = pill ?: return
        val lp = p.layoutParams as WindowManager.LayoutParams
        val sw = resources.displayMetrics.widthPixels
        val b = bubble?.layoutParams as? WindowManager.LayoutParams
        val by = b?.y ?: (resources.displayMetrics.heightPixels * 2 / 3)
        lp.y = maxOf(dp(40f), by - p.height - dp(10f))
        lp.x = if (prefs.bubbleLeft) dp(4f) else maxOf(0, sw - p.width - dp(4f))
        runCatching { wm.updateViewLayout(p, lp) }
    }

    private fun hidePill() {
        pill?.let { runCatching { wm.removeView(it) } }
        pill = null; pillStatus = null; pillVoice = null; pillRate = null; pillPause = null
    }

    private fun toast(m: String) = main.post { Toast.makeText(this, m, Toast.LENGTH_SHORT).show() }

    // ---- full-screen layer: pick outlines + reading highlight; in pick mode it takes taps --

    @SuppressLint("ViewConstructor")
    private inner class LayerView(ctx: Context) : View(ctx) {
        private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeWidth = dp(1.5f).toFloat(); color = 0xCC2F6FEB.toInt()
            pathEffect = DashPathEffect(floatArrayOf(dp(4f).toFloat(), dp(3f).toFloat()), 0f)
        }
        private val imgOutline = Paint(outline).apply { color = 0xCCE8912D.toInt() }
        private val press = Paint().apply { color = 0x332F6FEB }
        private val sent = Paint().apply { color = 0x40FFD54F }
        private val word = Paint().apply { color = 0x88FFB300.toInt() }
        private val bannerBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xF016161A.toInt() }
        private val bannerText = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = dp(13f).toFloat() }
        private val loc = IntArray(2)
        private val r = RectF()

        // drag replay
        private var downX = 0f; private var downY = 0f; private var dragging = false
        private val pts = ArrayList<FloatArray>() // x, y, t
        private val slop = ViewConfiguration.get(ctx).scaledTouchSlop

        override fun onDraw(c: Canvas) {
            getLocationOnScreen(loc)
            c.translate(-loc[0].toFloat(), -loc[1].toFloat()) // node bounds are in screen coords
            val pad = dp(3f).toFloat()
            if (picking) {
                for ((i, pr) in pickRects.withIndex()) {
                    val (b, img) = pr
                    if (b.isEmpty) continue
                    r.set(b); r.inset(-pad, -pad)
                    if (i == pressed) c.drawRoundRect(r, pad * 2, pad * 2, press)
                    c.drawRoundRect(r, pad * 2, pad * 2, if (img) imgOutline else outline)
                }
            }
            if (player.active) {
                imageRect?.let { c.drawRoundRect(it, pad * 2, pad * 2, sent) }
                for (l in curLines) { r.set(l); r.inset(-pad / 2, -pad / 2); c.drawRect(r, sent) }
                for (w in currentWordRects()) c.drawRect(w, word)
            }
            if (picking) {
                val msg = if (pickRects.isEmpty()) "Nothing readable found here" else "Tap a block to read from there · tap ✕ to close"
                val tw = bannerText.measureText(msg)
                val cx = width / 2f + loc[0]; val top = dp(40f).toFloat() + loc[1]
                r.set(cx - tw / 2 - dp(14f), top, cx + tw / 2 + dp(14f), top + dp(32f))
                c.drawRoundRect(r, dp(16f).toFloat(), dp(16f).toFloat(), bannerBg)
                c.drawText(msg, cx - tw / 2, top + dp(21f), bannerText)
            }
        }

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: MotionEvent): Boolean {
            if (!picking) return false
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; dragging = false
                    pts.clear(); pts.add(floatArrayOf(e.rawX, e.rawY, e.eventTime.toFloat()))
                    pressed = blockAtPick(e.rawX.toInt(), e.rawY.toInt()); invalidate()
                }
                MotionEvent.ACTION_MOVE -> {
                    for (h in 0 until e.historySize) pts.add(floatArrayOf(e.getHistoricalX(h) + e.rawX - e.x, e.getHistoricalY(h) + e.rawY - e.y, e.getHistoricalEventTime(h).toFloat()))
                    pts.add(floatArrayOf(e.rawX, e.rawY, e.eventTime.toFloat()))
                    if (!dragging && (abs(e.rawX - downX) > slop || abs(e.rawY - downY) > slop)) { dragging = true; pressed = -1; invalidate() }
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) replay(ArrayList(pts))
                    else {
                        val b = blockAtPick(e.rawX.toInt(), e.rawY.toInt())
                        val page = pickPage
                        pressed = -1; invalidate()
                        if (b >= 0 && page != null) { Log.i(TAG, "pick block $b"); readFromBlock(page, b) }
                    }
                }
                MotionEvent.ACTION_CANCEL -> { pressed = -1; invalidate() }
            }
            return true
        }

        /** Hand a drag to the app underneath: stop taking touches, replay the stroke, take them back. */
        private fun replay(p: List<FloatArray>) {
            if (p.size < 2) return
            setLayerTouchable(false)
            val path = Path().apply { moveTo(p[0][0], p[0][1]); for (q in p.drop(1)) lineTo(maxOf(0f, q[0]), maxOf(0f, q[1])) }
            val dur = (p.last()[2] - p[0][2]).toLong().coerceIn(40, 3000)
            main.postDelayed({
                val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, dur)).build()
                val done = object : GestureResultCallback() {
                    override fun onCompleted(d: GestureDescription?) = finish()
                    override fun onCancelled(d: GestureDescription?) = finish()
                    fun finish() { if (picking) setLayerTouchable(true); schedulePickIndex(350) }
                }
                if (!dispatchGesture(g, done, main)) done.finish()
            }, 30)
        }
    }

    // ---- debug hooks (debug builds only), for adb-driven tests -------------------------------

    private fun registerDebug() {
        val rx = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.getStringExtra("cmd")) {
                    "pick" -> startPick()
                    "unpick" -> endPick()
                    "block" -> { val p = pickPage ?: buildPage(); if (p != null) readFromBlock(p, i.getIntExtra("i", 0)) }
                    "dump" -> buildPage()?.let { p -> p.blocks.forEachIndexed { k, b -> Log.i(TAG, "block $k${if (b.image) " [image]" else ""} ${b.bounds().toShortString()}: ${b.text.take(120)}") } }
                    "select" -> readSelection(i.getStringExtra("text") ?: "", i.getBooleanExtra("here", false))
                    "stop" -> player.stop()
                    "server" -> prefs.setServer(i.getStringExtra("voice") ?: "clark", i.getStringExtra("url") ?: "")
                    "stats" -> Log.i(TAG, "cache ${cache.stats()} hits ${player.hits}")
                }
            }
        }
        val f = IntentFilter("app.readaloud.DEBUG")
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(rx, f, RECEIVER_EXPORTED) else registerReceiver(rx, f)
    }

    fun cacheStats() = cache.stats()
    fun clearAudioCache() = cache.clear()

    companion object {
        const val TAG = "ReadAloud"
        var instance: ReadAloudService? = null
    }
}
