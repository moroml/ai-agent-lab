package lab.aiagent.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class Res(val code: Int, val body: String) {
    val json: JSONObject? get() = runCatching { JSONObject(body) }.getOrNull()
    val detail: String? get() = json?.optString("detail")?.takeIf { it.isNotEmpty() }
}

// 失敗(接続不可・タイムアウト)は IOException。呼び出しはバックグラウンドスレッドで行う
fun httpCall(url: String, method: String = "GET", timeoutMs: Int = 4000, launcher: Boolean = false): Res {
    val c = URL(url).openConnection() as HttpURLConnection
    try {
        c.requestMethod = method
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        if (launcher) c.setRequestProperty("X-AAL-Launcher", "1")
        if (method == "POST") {
            c.doOutput = true
            c.setFixedLengthStreamingMode(0)
        }
        val code = c.responseCode
        val stream = if (code < 400) c.inputStream else c.errorStream
        return Res(code, stream?.bufferedReader()?.use { it.readText() } ?: "")
    } finally {
        c.disconnect()
    }
}
