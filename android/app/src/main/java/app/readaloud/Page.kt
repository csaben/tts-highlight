package app.readaloud

import android.graphics.Rect
import android.graphics.RectF
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH
import android.view.accessibility.AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX
import android.view.accessibility.AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY

// The screen's accessibility tree as readable text: leaves (text runs, images) grouped into
// blocks (paragraph-ish), flattened into one string the sentence splitter runs over, the same
// shape as the extension's page index. Works for Chrome's web content and native apps alike.
class Page private constructor(
    val full: String,
    val leaves: List<Leaf>,
    val blocks: List<Block>,
) {
    class Leaf(val node: AccessibilityNodeInfo, val text: String, val start: Int, val end: Int, val image: Boolean)
    class Block(val leaves: List<Leaf>, val start: Int, val end: Int, val image: Boolean) {
        fun bounds(): Rect {
            val r = Rect()
            val t = Rect()
            for (l in leaves) {
                l.node.refresh()
                l.node.getBoundsInScreen(t)
                if (!t.isEmpty) r.union(t)
            }
            return r
        }
        val text get() = leaves.joinToString(" ") { it.text }
    }

    /** One playable item: a sentence (start/end into full) or an image to OCR. */
    class Seg(val start: Int, val end: Int, val text: String?, val image: Leaf? = null, val block: Int)

    /** Sentences (and image placeholders) from block [first] on. */
    fun segsFrom(first: Int, firstMax: Int = 90): List<Seg> {
        val out = ArrayList<Seg>()
        val from = blocks.getOrNull(first)?.start ?: return out
        val sub = full.substring(from)
        val imgs = blocks.withIndex().filter { it.index >= first && it.value.image }.toMutableList()
        for (p in Text.segments(sub, firstMax)) {
            val a = from + p.start
            while (imgs.isNotEmpty() && blocks[imgs[0].index].start <= a) {
                val b = imgs.removeAt(0)
                out.add(Seg(b.value.start, b.value.end, null, b.value.leaves[0], b.index))
            }
            out.add(Seg(a, from + p.end, Text.clean(full.substring(a, from + p.end)), null, blockAt(a)))
        }
        for (b in imgs) out.add(Seg(b.value.start, b.value.end, null, b.value.leaves[0], b.index))
        return out
    }

    fun blockAt(pos: Int): Int {
        var lo = 0; var hi = blocks.size - 1; var ans = 0
        while (lo <= hi) {
            val m = (lo + hi) / 2
            if (blocks[m].start <= pos) { ans = m; lo = m + 1 } else hi = m - 1
        }
        return ans
    }

    /** Block under a screen point, or -1. */
    fun blockAtPoint(x: Int, y: Int): Int {
        var best = -1
        var bestArea = Long.MAX_VALUE
        for ((i, b) in blocks.withIndex()) {
            val r = b.bounds()
            if (r.contains(x, y)) {
                val a = r.width().toLong() * r.height()
                if (a < bestArea) { best = i; bestArea = a } // innermost wins
            }
        }
        return best
    }

    /** Screen rects covering full[a, b): per character where the app supports it, else per leaf. */
    fun rects(a: Int, b: Int): List<RectF> {
        val out = ArrayList<RectF>()
        for (l in leaves) {
            if (l.end <= a || l.start >= b || l.image) continue
            val s = maxOf(a, l.start) - l.start
            val e = minOf(b, l.end) - l.start
            val chars = charRects(l, s, e)
            if (chars != null) out.addAll(mergeLines(chars.filterNotNull().filter { it.width() > 0 || it.height() > 0 }))
            else { val r = Rect(); l.node.refresh(); l.node.getBoundsInScreen(r); out.add(RectF(r)) }
        }
        return out
    }

    /** Per-character rects for leaf text [s, e) (null entries = offscreen/unknown), or null if unsupported. */
    fun charRects(l: Leaf, s: Int, e: Int): List<RectF?>? {
        val n = l.node
        if (EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY !in n.availableExtraData) return null
        // leaf.text was trimmed; find its offset in the node's own text
        val raw = n.text?.toString() ?: return null
        val off = raw.indexOf(l.text.take(20)).coerceAtLeast(0)
        val args = Bundle().apply {
            putInt(EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, off + s)
            putInt(EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, minOf(e - s, 2000))
        }
        if (!n.refreshWithExtraData(EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY, args)) return null
        @Suppress("DEPRECATION")
        val arr = n.extras.getParcelableArray(EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY) ?: return null
        val rs = arr.map { (it as? RectF)?.takeIf { r -> r.width() > 0 || r.height() > 0 } }
        // Chrome reports some characters (at line wraps) with the whole run's box: drop outliers
        val hs = rs.filterNotNull().map { it.height() }.sorted()
        if (hs.isNotEmpty()) { val med = hs[hs.size / 2]; return rs.map { r -> r?.takeIf { it.height() <= med * 1.8f } }.let { l -> if (l.all { it == null }) null else l } }
        return if (rs.all { it == null }) null else rs
    }

    companion object {
        private val COUNT = Regex("^[\\d.,]+\\s*[KMB]?$", RegexOption.IGNORE_CASE)
        private val TIME = Regex("^(\\d+\\s*[smhdw]|\\d{1,2}:\\d{2}(\\s*[AP]M)?|[A-Z][a-z]{2} \\d{1,2}(, \\d{4})?)$")
        private val HANDLE = Regex("^@\\w+$")
        private val UI_WORDS = setOf("·", "views", "view", "show more", "show this thread", "follow", "following",
            "reply", "repost", "like", "share", "more", "translate post", "ad", "promoted", "pinned", "quote")

        /** Merge per-character rects into one rect per line. */
        fun mergeLines(chars: List<RectF>): List<RectF> {
            val out = ArrayList<RectF>()
            for (c in chars) {
                val last = out.lastOrNull()
                if (last != null && Math.abs(c.centerY() - last.centerY()) < last.height() / 2 && c.left >= last.left - 2) last.union(c)
                else out.add(RectF(c))
            }
            return out
        }

        fun build(root: AccessibilityNodeInfo, screenW: Int, ownPkg: String): Page? {
            // In browsers, only the web content (not the URL bar, tabs, toolbar)
            val web = findWeb(root, 0)
            val leaves = ArrayList<Pair<AccessibilityNodeInfo, Boolean>>() // node, image
            collect(web ?: root, leaves, screenW, ownPkg, 0)
            if (leaves.isEmpty()) return null
            // group consecutive leaves into blocks by parent (a link inside a paragraph stays in it)
            data class Raw(val nodes: MutableList<Pair<AccessibilityNodeInfo, String>>, val image: Boolean, val key: AccessibilityNodeInfo?, var bottom: Int)
            val raws = ArrayList<Raw>()
            for ((n, img) in leaves) {
                val text = if (img) "" else Text.clean(n.text.toString())
                val parent = n.parent
                val key = if (parent != null && isInline(parent)) parent.parent else parent
                val r = Rect(); n.getBoundsInScreen(r)
                val last = raws.lastOrNull()
                // same block = same parent AND it continues on the previous run's line (a link
                // inside a paragraph); starting below it means a new paragraph / post / row
                if (!img && last != null && !last.image && last.key != null && (last.key == key || last.key == parent) &&
                    r.top < last.bottom - 2) {
                    last.nodes.add(n to text); last.bottom = maxOf(last.bottom, r.bottom)
                } else raws.add(Raw(mutableListOf(n to text), img, key, r.bottom))
            }
            val sb = StringBuilder()
            val outLeaves = ArrayList<Leaf>()
            val blocks = ArrayList<Block>()
            for (r in raws) {
                if (!r.image && isUiChrome(r.nodes)) continue
                if (sb.isNotEmpty()) sb.append('\n')
                val bs = sb.length
                val bl = ArrayList<Leaf>()
                for ((n, t) in r.nodes) {
                    if (sb.length > bs && !r.image) {
                        val prev = sb.last()
                        if (!prev.isWhitespace() && t.isNotEmpty() && !",.;:!?)".contains(t[0])) sb.append(' ')
                    }
                    val s = sb.length
                    sb.append(t)
                    val leaf = Leaf(n, t, s, sb.length, r.image)
                    bl.add(leaf); outLeaves.add(leaf)
                }
                blocks.add(Block(bl, bs, sb.length, r.image))
            }
            if (blocks.isEmpty()) return null
            return Page(sb.toString(), outLeaves, blocks)
        }

        private fun findWeb(n: AccessibilityNodeInfo, depth: Int): AccessibilityNodeInfo? {
            if (depth > 30) return null
            if (n.className?.toString() == "android.webkit.WebView") return n
            for (i in 0 until n.childCount) {
                val c = n.getChild(i) ?: continue
                findWeb(c, depth + 1)?.let { return it }
            }
            return null
        }

        private fun isImage(n: AccessibilityNodeInfo): Boolean {
            val c = n.className?.toString() ?: return false
            return c == "android.widget.Image" || c == "android.widget.ImageView"
        }

        private fun isInline(n: AccessibilityNodeInfo): Boolean = n.isClickable && n.childCount <= 3

        /** Collect text leaves + big images in reading order. Returns the text it added (for dedupe). */
        private fun collect(n: AccessibilityNodeInfo, out: MutableList<Pair<AccessibilityNodeInfo, Boolean>>,
                            screenW: Int, ownPkg: String, depth: Int): String {
            if (depth > 60) return ""
            if (n.packageName?.toString() == ownPkg) return ""
            if (n.isEditable || n.isPassword) return ""
            if (isImage(n)) {
                val r = Rect(); n.getBoundsInScreen(r)
                if (r.width() >= screenW * 0.4 && r.height() >= 120) out.add(n to true) // embeds, not avatars/icons
                return ""
            }
            val sb = StringBuilder()
            for (i in 0 until n.childCount) {
                val c = n.getChild(i) ?: continue
                val t = collect(c, out, screenW, ownPkg, depth + 1)
                if (t.isNotEmpty()) { if (sb.isNotEmpty()) sb.append(' '); sb.append(t) }
            }
            val own = n.text?.toString()?.let { Text.clean(it) }.orEmpty()
            if (own.isEmpty()) return sb.toString()
            val kids = Text.clean(sb.toString())
            if (kids.isEmpty()) { out.add(n to false); return own }
            // children carry the text (Chrome gives the page container its <title>, layouts repeat
            // their TextViews): read the children, not the container's own text
            return kids
        }


        /** Names, handles, timestamps, counts, buttons: short link/button-only blocks. */
        private fun isUiChrome(nodes: List<Pair<AccessibilityNodeInfo, String>>): Boolean {
            val text = nodes.joinToString(" ") { it.second }.trim()
            if (text.isEmpty()) return true
            val words = text.split(Regex("\\s+")).size
            if (words > 6) return false
            val low = text.lowercase()
            if (COUNT.matches(text) || TIME.matches(text) || HANDLE.matches(text) || low in UI_WORDS) return true
            if (nodes.all { (n, _) -> n.className?.toString()?.endsWith("Button") == true }) return true
            // "Neuro Lab @neurolab · 3h": drop handle/time/count/dot runs, then the rest is all links
            val rest = nodes.filter { (_, t) ->
                val x = t.trim().trim('·').trim()
                !(x.isEmpty() || COUNT.matches(x) || TIME.matches(x) || HANDLE.matches(x) || x.lowercase() in UI_WORDS)
            }
            if (rest.isEmpty()) return true
            val restWords = rest.sumOf { it.second.split(Regex("\\s+")).size }
            return restWords <= 4 && rest.all { (n, _) -> n.isClickable || n.parent?.isClickable == true }
        }
    }
}
