package lab.aiagent.app

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import java.io.IOException

class MainActivity : AppCompatActivity() {
    private val prefs by lazy { getSharedPreferences("aal", Context.MODE_PRIVATE) }
    private var host = ""
    private var webView: WebView? = null
    private var webState: Bundle? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var job = 0 // 古いバックグラウンド処理の結果を捨てるための世代番号

    private lateinit var root: ViewGroup
    private lateinit var nativeScreen: View
    private lateinit var title: TextView
    private lateinit var message: TextView
    private lateinit var progress: ProgressBar
    private lateinit var input: EditText
    private lateinit var primary: Button
    private lateinit var secondary: Button

    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(it.resultCode, it.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        nativeScreen = findViewById(R.id.native_screen)
        title = findViewById(R.id.title)
        message = findViewById(R.id.message)
        progress = findViewById(R.id.progress)
        input = findViewById(R.id.host_input)
        primary = findViewById(R.id.primary)
        secondary = findViewById(R.id.secondary)

        // WebView がシステムバーの下に描画されないよう余白を付ける
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = webView
                if (w != null && w.canGoBack()) w.goBack() else finish()
            }
        })

        host = prefs.getString("host", "") ?: ""
        webState = savedInstanceState?.getBundle("web")
        if (host.isEmpty()) showSetup() else check()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.let { w -> outState.putBundle("web", Bundle().also { w.saveState(it) }) }
    }

    override fun onDestroy() {
        job++
        fileCallback?.onReceiveValue(null)
        webView?.destroy()
        super.onDestroy()
    }

    // ---- ネイティブ画面 ----

    private fun show(
        titleText: String? = null, text: String? = null, busy: Boolean = false, edit: Boolean = false,
        primaryText: String? = null, onPrimary: () -> Unit = {}, canChangeHost: Boolean = true,
    ) {
        nativeScreen.isVisible = true
        title.isVisible = titleText != null
        title.text = titleText
        message.isVisible = text != null
        message.text = text
        progress.isVisible = busy
        input.isVisible = edit
        primary.isVisible = primaryText != null
        primary.text = primaryText
        primary.setOnClickListener { onPrimary() }
        secondary.isVisible = canChangeHost
        secondary.setOnClickListener { showSetup() }
    }

    private fun showSetup() {
        job++
        closeWeb()
        input.setText(host.ifEmpty { BuildConfig.DEFAULT_HOST })
        show(titleText = getString(R.string.setup_label), edit = true, primaryText = getString(R.string.save),
            onPrimary = {
                // スキーム・パス・ポートを除いてホスト名だけ保存する
                val h = input.text.toString().trim().removePrefix("https://").removePrefix("http://")
                    .substringBefore('/').substringBefore(':')
                if (h.isNotEmpty()) {
                    host = h
                    prefs.edit().putString("host", h).apply()
                    check()
                }
            }, canChangeHost = false)
    }

    // 8765 の /health を見て、WebView かネイティブの停止画面かを決める
    private fun check() {
        val my = ++job
        closeWeb()
        show(text = getString(R.string.checking), busy = true)
        Thread {
            val ok = try { httpCall("https://$host:8765/health").code == 200 } catch (e: IOException) { false }
            runOnUiThread { if (my == job) if (ok) openWeb() else checkLauncher() }
        }.start()
    }

    // 8766 の /status に届くかで、起動ボタンか到達不能の案内かを決める
    private fun checkLauncher() {
        val my = ++job
        show(titleText = getString(R.string.stopped), text = getString(R.string.checking), busy = true)
        Thread {
            val reachable = try { httpCall("https://$host:8766/status").code == 200 } catch (e: IOException) { false }
            runOnUiThread {
                if (my != job) return@runOnUiThread
                if (reachable) showStopped()
                else show(titleText = getString(R.string.stopped), text = getString(R.string.unreachable),
                    primaryText = getString(R.string.recheck), onPrimary = { check() })
            }
        }.start()
    }

    private fun showStopped(error: String? = null) {
        show(titleText = getString(R.string.stopped), text = error,
            primaryText = getString(R.string.start), onPrimary = { start() })
    }

    // 起動を依頼し、2秒おきに最大150秒 /status を見る
    private fun start() {
        val my = ++job
        show(titleText = getString(R.string.stopped), text = getString(R.string.starting), busy = true)
        Thread {
            var error: String? = null
            try {
                val r = httpCall("https://$host:8766/start", "POST", 10000, launcher = true)
                if (r.code >= 400) error = r.detail ?: "HTTP ${r.code}"
                val deadline = System.currentTimeMillis() + 150_000
                while (error == null && my == job) {
                    if (System.currentTimeMillis() > deadline) { error = getString(R.string.start_timeout); break }
                    Thread.sleep(2000)
                    try {
                        val s = httpCall("https://$host:8766/status")
                        if (s.code >= 400) error = s.detail ?: "HTTP ${s.code}"
                        else if (s.json?.optBoolean("running") == true) break
                        else if (s.json?.optBoolean("starting") == false) s.detail?.let { error = it } // PC側で起動に失敗した
                    } catch (e: IOException) { /* 一時的な失敗は期限まで待つ */ }
                }
            } catch (e: IOException) {
                error = e.message ?: e.toString()
            }
            runOnUiThread {
                if (my != job) return@runOnUiThread
                if (error == null) openWeb() else showStopped(error)
            }
        }.start()
    }

    // ---- WebView ----

    private fun closeWeb() {
        webView?.let { root.removeView(it); it.destroy() }
        webView = null
    }

    private fun openWeb() {
        job++
        nativeScreen.isVisible = false
        val w = WebView(this)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == host) return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) view.post { check() } // コールバック内で破棄しない
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                try {
                    pickFile.launch(params.createIntent())
                } catch (e: Exception) {
                    fileCallback = null
                    callback.onReceiveValue(null)
                }
                return true
            }
        }
        w.setDownloadListener { url, userAgent, disposition, mime, _ ->
            try {
                val name = URLUtil.guessFileName(url, disposition, mime)
                val req = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", userAgent)
                    .setMimeType(mime)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            } catch (e: Exception) {
                Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show()
            }
        }
        root.addView(w, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        webView = w
        val state = webState
        webState = null
        if (state != null && w.restoreState(state) != null) return
        w.loadUrl("https://$host:8765/")
    }
}
