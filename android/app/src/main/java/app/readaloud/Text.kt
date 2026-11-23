package app.readaloud

// Kotlin port of extension/segment.js: sentence splitting for TTS chunks, pronunciation rules,
// acronym spelling and plain-text math. Keep the two in step.
object Text {
    data class Seg(val start: Int, val end: Int)

    private val ABBREV = setOf(
        "mr", "mrs", "ms", "dr", "st", "vs", "jr", "sr", "prof", "inc", "ltd", "co", "etc",
        "e.g", "i.e", "fig", "no", "vol", "approx", "dept", "est", "u.s", "a.m", "p.m",
    )
    private const val CLOSERS = "\"'”’)]}»"
    private val HAS_WORD = Regex("[\\p{L}\\p{N}]")
    private val TRAIL_WORD = Regex("([\\p{L}.]+)$")
    private val ONE_UPPER = Regex("^\\p{Lu}$")

    private fun sentences(s: String): List<Seg> {
        val out = ArrayList<Seg>()
        var start = 0
        fun push(a0: Int, b0: Int) {
            var a = a0; var b = b0
            while (a < b && s[a].isWhitespace()) a++
            while (b > a && s[b - 1].isWhitespace()) b--
            if (b > a && HAS_WORD.containsMatchIn(s.substring(a, b))) out.add(Seg(a, b))
        }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\n') { push(start, i); start = i + 1; i++; continue }
            if (c != '.' && c != '!' && c != '?' && c != '…') { i++; continue }
            var j = i + 1
            while (j < s.length && ".!?…".indexOf(s[j]) >= 0) j++
            while (j < s.length && CLOSERS.indexOf(s[j]) >= 0) j++
            if (j < s.length && !s[j].isWhitespace()) { i++; continue } // 3.5, example.com
            if (c == '.') {
                val m = TRAIL_WORD.find(s.substring(maxOf(start, i - 12), i))
                val w = m?.groupValues?.get(1) ?: ""
                if (w.lowercase() in ABBREV || ONE_UPPER.matches(w)) { i++; continue } // Dr. / J. Smith
            }
            push(start, j)
            start = j
            i = j
        }
        push(start, s.length)
        return out
    }

    private val PUNCT = Regex("[,;:—–)](?=\\s)")

    private fun splitLong(s: String, seg: Seg, limit: Int): List<Seg> {
        val out = ArrayList<Seg>()
        var start = seg.start
        val end = seg.end
        while (end - start > limit) {
            val window = s.substring(start, minOf(s.length, start + limit))
            var cut = -1
            for (m in PUNCT.findAll(window)) if (m.range.first > 25) cut = m.range.first + 1
            if (cut < 0) cut = window.lastIndexOf(' ')
            if (cut < 15) cut = limit
            out.add(Seg(start, start + cut))
            start += cut
            while (start < end && s[start].isWhitespace()) start++
        }
        if (end > start) out.add(Seg(start, end))
        return out
    }

    /** First chunk ≤ firstMax chars so audio starts fast; later chunks are whole sentences. */
    fun segments(s: String, firstMax: Int = 90, maxLen: Int = 260): List<Seg> {
        val out = ArrayList<Seg>()
        for (sent in sentences(s)) {
            for (p in splitLong(s, sent, if (out.isEmpty()) firstMax else maxLen)) {
                if (out.isEmpty() && p.end - p.start > firstMax) out.addAll(splitLong(s, p, firstMax))
                else if (HAS_WORD.containsMatchIn(s.substring(p.start, p.end))) out.add(p)
            }
        }
        return out
    }

    fun clean(t: String) = t.replace(Regex("\\s+"), " ").trim()

    // ---- pronunciation ------------------------------------------------------------------
    private val KEEP = setOf("NASA", "NATO", "RAM", "ROM", "SCUBA", "LASER", "RADAR", "FIFA", "GIF",
        "JPEG", "PIN", "OK", "UNESCO", "COVID", "CAPTCHA", "ASAP", "SIM", "WIFI", "LAN", "WAN", "DOS",
        "YOLO", "FOMO", "NAND", "CUDA", "AIDS", "LOL", "ROI")

    private val SUP = mapOf('⁰' to "0", '¹' to "1", '²' to "2", '³' to "3", '⁴' to "4", '⁵' to "5",
        '⁶' to "6", '⁷' to "7", '⁸' to "8", '⁹' to "9", '⁻' to "-", '⁺' to "+", 'ⁿ' to "n", 'ⁱ' to "i", 'ᵀ' to "T")
    private val SYM = mapOf("×" to "times", "÷" to "divided by", "≈" to "approximately",
        "≤" to "less than or equal to", "≥" to "greater than or equal to", "≠" to "not equal to",
        "±" to "plus or minus", "→" to "to", "∞" to "infinity", "√" to "square root of",
        "∑" to "sum of", "∈" to "in")

    private fun power(p: String): String = when (p) {
        "2" -> " squared"
        "3" -> " cubed"
        "T" -> " transpose"
        else -> " to the " + p.replace(Regex("^[-−]"), "minus ").replace(Regex("^\\+"), "")
    }

    private val RE_SUP = Regex("([\\p{L}\\p{N})\\]])([⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺ⁿⁱᵀ]+)")
    private val RE_CARET = Regex("([\\p{L}\\p{N})\\]])\\^\\{?\\(?([-−+]?(?:\\d+(?:\\.\\d+)?|[a-zA-Z]))\\)?\\}?")
    private val RE_SCI = Regex("\\b(\\d+(?:\\.\\d+)?)e([-−+]?)(\\d+)\\b")
    private val RE_ABOUT = Regex("(^|[\\s(])~\\s?(?=\\d)")
    private val RE_SYM = Regex("\\s?([×÷≈≤≥≠±→∞√∑∈])\\s?")

    fun plainMath(t0: String): String {
        var t = t0
        t = RE_SUP.replace(t) { m -> m.groupValues[1] + power(m.groupValues[2].map { SUP[it] ?: "" }.joinToString("")) }
        t = RE_CARET.replace(t) { m -> m.groupValues[1] + power(m.groupValues[2]) }
        t = RE_SCI.replace(t) { m ->
            val sign = m.groupValues[2]
            "${m.groupValues[1]} e ${if (sign.isNotEmpty() && sign != "+") "minus " else ""}${m.groupValues[3]}"
        }
        t = RE_ABOUT.replace(t) { m -> m.groupValues[1] + "about " }
        t = RE_SYM.replace(t) { m -> " ${SYM[m.groupValues[1]]} " }
        return t.replace(Regex(" {2,}"), " ")
    }

    data class Rule(val re: Regex, val say: String, val key: String)

    /** One rule per line: "word = say it like this". Lines starting with # are ignored. */
    fun parseLex(src: String?): List<Rule> {
        val rules = ArrayList<Rule>()
        val line = Regex("^\\s*([^=#][^=]*?)\\s*=\\s*(.*?)\\s*$")
        for (l in (src ?: "").split(Regex("\\r?\\n"))) {
            val m = line.find(l) ?: continue
            val word = m.groupValues[1]
            if (word.isEmpty()) continue
            rules.add(Rule(
                Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(word) + "(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE),
                m.groupValues[2], word.lowercase()))
        }
        return rules
    }

    private val RE_DOTDOT = Regex("(?<!\\.)\\.\\.(?!\\.)")
    private val RE_ACRO = Regex("(?<![\\p{L}\\p{N}.])(\\p{Lu}{2,5})(s?)(?![\\p{L}\\p{N}])(\\.?)")

    fun lex(text0: String, rules: List<Rule> = emptyList(), auto: Boolean = true): String {
        var text = text0
        val own = rules.map { it.key }.toSet()
        for (r in rules) text = r.re.replace(text) { r.say }
        text = RE_DOTDOT.replace(text, ".") // "A.S.A.P.." from a rule at sentence end
        if (!auto) return text
        text = plainMath(text)
        val letters = text.filter { it.isLetter() }
        val caps = letters.count { it.isUpperCase() }
        if (letters.length > 12 && caps.toDouble() / letters.length > 0.6) return text // SHOUTED TEXT
        return RE_ACRO.replace(text) { m ->
            val ac = m.groupValues[1]; val s = m.groupValues[2]
            if (ac in KEEP || ac.lowercase() in own || (ac + s).lowercase() in own) m.value
            else ac.toCharArray().joinToString(".") + "." + s // trailing sentence "." is absorbed
        }
    }
}
