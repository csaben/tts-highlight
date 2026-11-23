package app.readaloud

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast

// "Read aloud" / "Read from here" in the text selection menu (Chrome and most apps). Invisible:
// hands the selection to the accessibility service and gets out of the way so the service can
// see the app's window again.
open class ProcessTextActivity : Activity() {
    open val fromHere = false

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString().orEmpty()
        val svc = ReadAloudService.instance
        finish()
        overridePendingTransition(0, 0)
        if (text.isBlank()) return
        if (svc == null) {
            Toast.makeText(this, "Turn on Read Aloud in Accessibility settings first", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        Handler(Looper.getMainLooper()).postDelayed({ svc.readSelection(text, fromHere) }, 250)
    }
}

class ReadFromHereActivity : ProcessTextActivity() {
    override val fromHere = true
}
