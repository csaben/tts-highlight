package app.readaloud

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

// Settings: voice, speed, servers, pronunciation, cache, images, bubble. Built in code (no XML).
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var cacheLine: TextView
    private val dp get() = resources.displayMetrics.density

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        prefs = Prefs(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * dp).toInt(), (24 * dp).toInt(), (20 * dp).toInt(), (40 * dp).toInt())
        }
        setContentView(ScrollView(this).apply { addView(col); fitsSystemWindows = true })

        col.addView(TextView(this).apply { text = "Read Aloud"; textSize = 24f; setTypeface(typeface, Typeface.BOLD) })
        status = TextView(this).apply { textSize = 14f; setPadding(0, (8 * dp).toInt(), 0, (4 * dp).toInt()) }
        col.addView(status)
        col.addView(Button(this).apply {
            text = "Open Accessibility settings"
            setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        })
        col.addView(hint("How to use: tap the floating Aa bubble to outline the readable blocks, then tap one to " +
            "read from there to the end of the page. It stays up so you can tap another block to jump; tap ✕ to close. " +
            "Drag to scroll as usual. Or select text and choose Read aloud / Read from here in the menu. " +
            "Hold the bubble to open this screen."))

        col.addView(head("Voice"))
        val rg = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        for (v in Prefs.VOICES) rg.addView(RadioButton(this).apply {
            text = Prefs.NAMES[v]; id = View.generateViewId(); isChecked = prefs.voice == v
            setOnCheckedChangeListener { _, c -> if (c) prefs.voice = v }
        })
        col.addView(rg)

        col.addView(head("Speed"))
        val rateLbl = TextView(this)
        col.addView(rateLbl)
        col.addView(SeekBar(this).apply {
            max = 14 // 0.5 .. 4 in 0.25 steps
            progress = ((prefs.rate - 0.5f) / 0.25f).toInt()
            rateLbl.text = "${prefs.rate}×"
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, p: Int, u: Boolean) { val r = 0.5f + p * 0.25f; rateLbl.text = "$r×"; if (u) prefs.rate = r }
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) {}
            })
        })

        col.addView(head("Pronunciation"))
        col.addView(check("Spell out acronyms and math symbols (ASI → A.S.I., x² → x squared)", prefs.autoAcronyms) { prefs.autoAcronyms = it })
        col.addView(hint("One per line: word = how to say it"))
        col.addView(EditText(this).apply {
            setText(prefs.lex); minLines = 3; gravity = Gravity.TOP; hint = "Nvidia = en-vidia"
            addTextChangedListener(watch { prefs.lex = it })
        })

        col.addView(head("Reading"))
        col.addView(check("Read text inside images (on-device OCR)", prefs.ocr) { prefs.ocr = it })
        col.addView(check("Show the floating bubble", prefs.bubble) { prefs.bubble = it; ReadAloudService.instance?.setBubbleShown(it) })
        col.addView(check("Reuse audio already made (instant re-reads)", prefs.cache) { prefs.cache = it })
        cacheLine = TextView(this).apply { textSize = 13f; setTextColor(Color.GRAY) }
        col.addView(cacheLine)
        col.addView(Button(this).apply { text = "Clear audio cache"; setOnClickListener { AudioCache(cacheDir).clear(); refresh() } })

        col.addView(head("Servers"))
        for (v in Prefs.VOICES) {
            col.addView(TextView(this).apply { text = Prefs.NAMES[v] })
            val dot = TextView(this).apply { textSize = 12f }
            col.addView(EditText(this).apply {
                setText(prefs.server(v)); isSingleLine = true
                addTextChangedListener(watch { prefs.setServer(v, it) })
            })
            col.addView(dot)
            thread { // health check
                val ok = runCatching {
                    (URL(prefs.server(v) + "/llms.txt").openConnection() as HttpURLConnection).run { connectTimeout = 4000; readTimeout = 4000; responseCode in 200..499 }
                }.getOrDefault(false)
                runOnUiThread { dot.text = if (ok) "● reachable" else "● not reachable (on the tailnet?)"; dot.setTextColor(if (ok) 0xFF16A34A.toInt() else 0xFFDC2626.toInt()) }
            }
        }
        col.addView(TextView(this).apply { text = "Quality (sampling steps, lower = faster)" })
        val stLbl = TextView(this).apply { text = prefs.steps.toString() }
        col.addView(stLbl)
        col.addView(SeekBar(this).apply {
            max = 14; progress = (prefs.steps - 4) / 2
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, p: Int, u: Boolean) { val st = 4 + p * 2; stLbl.text = "$st"; if (u) prefs.steps = st }
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) {}
            })
        })
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun refresh() {
        val on = ReadAloudService.instance != null
        status.text = if (on) "● Running. Tap the Aa bubble in any app." else "● Off: turn on \"Read Aloud\" under Accessibility → Installed apps."
        status.setTextColor(if (on) 0xFF16A34A.toInt() else 0xFFDC2626.toInt())
        val (n, bytes) = AudioCache(cacheDir).stats()
        cacheLine.text = "Cached: $n sentences, ${"%.1f".format(bytes / 1048576.0)} MB"
    }

    private fun head(t: String) = TextView(this).apply {
        text = t; textSize = 17f; setTypeface(typeface, Typeface.BOLD); setPadding(0, (22 * dp).toInt(), 0, (4 * dp).toInt())
    }
    private fun hint(t: String) = TextView(this).apply { text = t; textSize = 13f; setTextColor(Color.GRAY); setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt()) }
    private fun check(t: String, v: Boolean, on: (Boolean) -> Unit) = CheckBox(this).apply {
        text = t; isChecked = v; setOnCheckedChangeListener { _, c -> on(c) }
    }
    private fun watch(on: (String) -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: Editable?) = on(s.toString())
    }
}
