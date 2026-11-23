package app.readaloud

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.Future

// Port of extension/offscreen.js. Fetches one segment at a time (the voice server runs one
// synthesis at a time), LOOKAHEAD ahead, plays with time-stretch (speed without pitch change).
// Items can be image placeholders: when reading reaches one, the listener OCRs it and calls
// resolve() with its text (or nothing, to skip it). All public methods run on the main thread.
class Player(private val cache: AudioCache, private val listener: Listener) {
    interface Listener {
        fun onLoading(index: Int, total: Int)
        fun onPlaying(index: Int, total: Int)
        fun onPaused(paused: Boolean)
        fun onNeedImage(index: Int, item: Item)
        fun onError(message: String)
        fun onDone()
    }

    class Item(val text: String?, val tag: Any?, val image: Boolean = false)

    private class Session(
        val items: MutableList<Item>, var base: String, var voice: String, val steps: Int,
        val useCache: Boolean,
    ) {
        var idx = 0
        var tok = 0
        var gen = 0 // bumped when items shift (image resolved) or voice changes: invalidates fetches
        val pending = HashMap<Int, Future<*>>()
        val ready = HashMap<Int, AudioCache.Hit>()
        var hits = 0
    }

    private val main = Handler(Looper.getMainLooper())
    private val net = Executors.newSingleThreadExecutor()
    private var s: Session? = null
    private var mp: MediaPlayer? = null
    var rate = 2f; private set
    var paused = false; private set
    val active get() = s != null
    val index get() = s?.idx ?: -1
    val items: List<Item> get() = s?.items ?: emptyList()
    val hits get() = s?.hits ?: 0

    fun play(items: List<Item>, base: String, voice: String, steps: Int, rate: Float, useCache: Boolean) {
        stop(silent = true)
        this.rate = rate
        paused = false
        s = Session(items.toMutableList(), base, voice, steps, useCache)
        playIdx(0)
    }

    /** Position within the current segment, 0..1, for the word highlight. */
    fun progress(): Float {
        val p = mp ?: return 0f
        return try { if (p.duration > 0) p.currentPosition.toFloat() / p.duration else 0f } catch (_: Exception) { 0f }
    }

    private fun playIdx(i: Int) {
        val sess = s ?: return
        releaseMp()
        if (i >= sess.items.size) { s = null; listener.onDone(); return }
        sess.idx = maxOf(0, i)
        val tok = ++sess.tok
        val item = sess.items[sess.idx]
        if (item.image && item.text == null) { listener.onNeedImage(sess.idx, item); return }
        pump(sess)
        listener.onLoading(sess.idx, sess.items.size)
        whenReady(sess, sess.idx, tok)
    }

    private fun whenReady(sess: Session, i: Int, tok: Int) {
        if (sess !== s || sess.tok != tok) return
        val hit = sess.ready[i]
        if (hit == null) { main.postDelayed({ whenReady(sess, i, tok) }, 30); return }
        if (hit.file.length() == 0L) { listener.onError("synthesis failed"); return }
        start(sess, hit, tok)
    }

    private fun start(sess: Session, hit: AudioCache.Hit, tok: Int) {
        val p = MediaPlayer()
        mp = p
        try {
            p.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            p.setDataSource(hit.file.path)
            p.prepare()
            p.setOnCompletionListener { if (sess === s && sess.tok == tok) playIdx(sess.idx + 1) }
            if (!paused) {
                p.playbackParams = PlaybackParams().setSpeed(rate).setPitch(1f)
                p.start()
            }
            listener.onPlaying(sess.idx, sess.items.size)
        } catch (e: Exception) {
            Log.w(TAG, "playback", e)
            listener.onError("playback: ${e.message}")
        }
        // drop audio we will not need again (keep one behind for "previous")
        sess.ready.keys.filter { it < sess.idx - 1 }.forEach { sess.ready.remove(it) }
    }

    private fun pump(sess: Session) {
        val end = minOf(sess.items.size, sess.idx + LOOKAHEAD)
        for (i in sess.idx until end) {
            val item = sess.items[i]
            if (item.text == null) break // unresolved image: fetch past it once it's known
            if (sess.ready.containsKey(i) || sess.pending.containsKey(i)) continue
            val key = AudioCache.key(sess.base, sess.steps, item.text)
            if (sess.useCache) {
                val hit = cache.get(key)
                if (hit != null) { sess.ready[i] = hit; sess.hits++; continue }
            }
            val gen = sess.gen
            val base = sess.base
            sess.pending[i] = net.submit {
                if (sess !== s || gen != sess.gen || i < sess.idx) { // jumped past it / stopped while queued
                    main.post { if (gen == sess.gen) sess.pending.remove(i) }
                    return@submit
                }
                val hit = try { fetch(base, sess.steps, item.text, key, sess.useCache) } catch (e: Exception) {
                    Log.w(TAG, "fetch", e)
                    null
                }
                main.post {
                    if (sess !== s || gen != sess.gen) return@post
                    sess.pending.remove(i)
                    sess.ready[i] = hit ?: AudioCache.Hit(File(""), 0f) // empty file = error at play time
                }
            }
        }
    }

    private fun fetch(base: String, steps: Int, text: String, key: String, useCache: Boolean): AudioCache.Hit {
        var last: Exception? = null
        repeat(2) {
            try {
                val c = URL("$base/synthesize").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.connectTimeout = 8000
                c.readTimeout = 60000
                c.setRequestProperty("content-type", "application/json")
                val body = org.json.JSONObject().put("text", text).put("format", "wav").put("num_steps", steps)
                c.outputStream.use { it.write(body.toString().toByteArray()) }
                if (c.responseCode != 200) throw Exception("server ${c.responseCode}")
                val dur = c.getHeaderField("x-audio-duration")?.toFloatOrNull() ?: 0f
                val data = c.inputStream.use { it.readBytes() }
                Log.i(TAG, "synth ${data.size}B ${dur}s: $text")
                return if (useCache) cache.put(key, data, dur) else {
                    val f = File.createTempFile("seg", ".wav", tmpDir); f.writeBytes(data); f.deleteOnExit()
                    AudioCache.Hit(f, dur)
                }
            } catch (e: Exception) { last = e }
        }
        throw last!!
    }

    /** Replace image placeholder [index] with its OCR'd segments (empty = skip it). */
    fun resolve(index: Int, segs: List<Item>) {
        val sess = s ?: return
        if (index >= sess.items.size || !sess.items[index].image) return
        sess.items.removeAt(index)
        sess.items.addAll(index, segs)
        // indices after it shifted: forget queued audio past the image
        sess.gen++
        sess.pending.clear()
        sess.ready.keys.filter { it >= index }.forEach { sess.ready.remove(it) }
        if (sess.idx == index) playIdx(index)
    }

    fun toggle() {
        val p = mp
        paused = !paused
        if (p != null) {
            try {
                if (paused) p.pause() else { p.playbackParams = PlaybackParams().setSpeed(rate).setPitch(1f); p.start() }
            } catch (_: Exception) {}
        }
        listener.onPaused(paused)
    }

    fun next() { val sess = s ?: return; playIdx(sess.idx + 1) }
    fun prev() {
        val sess = s ?: return
        val p = mp
        if (p != null && try { p.currentPosition > 1500 * rate } catch (_: Exception) { false }) { p.seekTo(0); return }
        playIdx(maxOf(0, sess.idx - 1))
    }
    fun jump(i: Int) { val sess = s ?: return; playIdx(i.coerceIn(0, sess.items.size)) }

    fun setRate(r: Float) {
        rate = (Math.round(r.coerceIn(0.5f, 4f) * 100) / 100f)
        val p = mp ?: return
        if (!paused) try { p.playbackParams = PlaybackParams().setSpeed(rate).setPitch(1f) } catch (_: Exception) {}
    }

    fun setVoice(voice: String, base: String) {
        val sess = s ?: return
        if (base == sess.base) return
        sess.base = base; sess.voice = voice
        sess.gen++; sess.pending.clear(); sess.ready.clear()
        playIdx(sess.idx)
    }

    fun stop(silent: Boolean = false) {
        val had = s != null
        s = null
        releaseMp()
        if (had && !silent) listener.onDone()
    }

    private fun releaseMp() {
        mp?.let { try { it.setOnCompletionListener(null); it.stop() } catch (_: Exception) {}; it.release() }
        mp = null
    }

    companion object {
        const val TAG = "ReadAloud"
        const val LOOKAHEAD = 3
        var tmpDir: File? = null
    }
}
