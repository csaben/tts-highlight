import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Voice server URLs come from android/local.properties (gitignored), e.g.
//   tts.clark=http://your-gpu-host:50300
//   tts.baldree=http://your-gpu-host:50301
val local = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun localUrl(key: String, def: String) = "\"" + (local.getProperty(key) ?: def) + "\""

android {
    namespace = "app.readaloud"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.readaloud"
        minSdk = 30 // AccessibilityService.takeScreenshot (image OCR)
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "CLARK_URL", localUrl("tts.clark", "http://localhost:50300"))
        buildConfigField("String", "BALDREE_URL", localUrl("tts.baldree", "http://localhost:50301"))
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        // Stable key so updates install over the previous version. Lives outside the repo.
        create("release") {
            storeFile = file(local.getProperty("sign.store") ?: "${System.getProperty("user.home")}/.android/debug.keystore")
            storePassword = local.getProperty("sign.pass") ?: "android"
            keyAlias = local.getProperty("sign.alias") ?: "androiddebugkey"
            keyPassword = local.getProperty("sign.pass") ?: "android"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            ndk { abiFilters += "arm64-v8a" } // phones; debug keeps all ABIs for the x86_64 emulator
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.google.mlkit:text-recognition:16.0.1") // on-device OCR for images
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // the android.jar stub throws in unit tests
}
