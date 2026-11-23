package app.readaloud

import android.content.Context
import android.content.SharedPreferences

class Prefs(ctx: Context) {
    val sp: SharedPreferences = ctx.getSharedPreferences("readaloud", Context.MODE_PRIVATE)

    var voice: String
        get() = sp.getString("voice", "clark")!!
        set(v) = sp.edit().putString("voice", v).apply()
    var rate: Float
        get() = sp.getFloat("rate", 2f)
        set(v) = sp.edit().putFloat("rate", v.coerceIn(0.5f, 4f)).apply()
    var steps: Int
        get() = sp.getInt("steps", 16)
        set(v) = sp.edit().putInt("steps", v).apply()
    var lex: String
        get() = sp.getString("lex", "")!!
        set(v) = sp.edit().putString("lex", v).apply()
    var autoAcronyms: Boolean
        get() = sp.getBoolean("autoAcronyms", true)
        set(v) = sp.edit().putBoolean("autoAcronyms", v).apply()
    var cache: Boolean
        get() = sp.getBoolean("cache", true)
        set(v) = sp.edit().putBoolean("cache", v).apply()
    var ocr: Boolean // read text inside images while reading a page
        get() = sp.getBoolean("ocr", true)
        set(v) = sp.edit().putBoolean("ocr", v).apply()
    var bubble: Boolean
        get() = sp.getBoolean("bubble", true)
        set(v) = sp.edit().putBoolean("bubble", v).apply()
    var bubbleY: Int
        get() = sp.getInt("bubbleY", -1)
        set(v) = sp.edit().putInt("bubbleY", v).apply()
    var bubbleLeft: Boolean
        get() = sp.getBoolean("bubbleLeft", false)
        set(v) = sp.edit().putBoolean("bubbleLeft", v).apply()

    fun server(v: String = voice): String =
        sp.getString("server.$v", null)?.takeIf { it.isNotBlank() }
            ?: if (v == "baldree") BuildConfig.BALDREE_URL else BuildConfig.CLARK_URL
    fun setServer(v: String, url: String) = sp.edit().putString("server.$v", url.trim().trimEnd('/')).apply()

    companion object {
        val VOICES = listOf("clark", "baldree")
        val NAMES = mapOf("clark" to "Clark", "baldree" to "Baldree")
    }
}
