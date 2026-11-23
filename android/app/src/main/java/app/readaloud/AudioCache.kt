package app.readaloud

import java.io.File
import java.security.MessageDigest

// Synthesized sentences on disk, keyed by server + steps + exact spoken text (same key as the
// extension's IndexedDB cache). Least recently used goes first past MAX bytes.
class AudioCache(dir: File) {
    private val root = File(dir, "audio").apply { mkdirs() }
    private var bytes = -1L

    data class Hit(val file: File, val durSec: Float)

    private fun name(key: String): String =
        MessageDigest.getInstance("SHA-1").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }

    @Synchronized fun get(key: String): Hit? {
        val f = File(root, name(key) + ".wav")
        if (!f.exists()) return null
        f.setLastModified(System.currentTimeMillis()) // touch for LRU
        val dur = File(root, name(key) + ".dur").takeIf { it.exists() }?.readText()?.toFloatOrNull() ?: 0f
        return Hit(f, dur)
    }

    @Synchronized fun put(key: String, data: ByteArray, durSec: Float): Hit {
        val n = name(key)
        val f = File(root, "$n.wav")
        if (bytes < 0) bytes = root.listFiles()?.sumOf { it.length() } ?: 0
        if (f.exists()) bytes -= f.length()
        f.writeBytes(data)
        File(root, "$n.dur").writeText(durSec.toString())
        bytes += data.size
        if (bytes > MAX) evict()
        return Hit(f, durSec)
    }

    private fun evict() {
        val wavs = root.listFiles { f -> f.name.endsWith(".wav") }?.sortedBy { it.lastModified() } ?: return
        for (w in wavs) {
            if (bytes <= MAX * 9 / 10) break
            bytes -= w.length()
            w.delete()
            File(root, w.name.removeSuffix(".wav") + ".dur").delete()
        }
    }

    @Synchronized fun stats(): Pair<Int, Long> {
        val wavs = root.listFiles { f -> f.name.endsWith(".wav") } ?: emptyArray()
        return wavs.size to wavs.sumOf { it.length() }
    }

    @Synchronized fun clear() {
        root.listFiles()?.forEach { it.delete() }
        bytes = 0
    }

    companion object {
        const val MAX = 500L * 1024 * 1024
        fun key(base: String, steps: Int, text: String) = "$base|$steps|$text"
    }
}
