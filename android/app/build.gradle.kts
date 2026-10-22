import java.util.Base64
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}
// Bundled runtime payload, npm/npx trampoline and packaging checks (plan §2.1, §4.9). Applied via file():
// lint follows a string `apply(from = ...)` into the script and crashes analysing it (findFirCompiledSymbol).
apply(from = file("runtime-packaging.gradle.kts"))
// Android library list for THIRD_PARTY_NOTICES, from the resolved runtime classpath's POMs (plan §5.3, task 4.5).
// Applied via file() for the same lint reason.
apply(from = file("notices.gradle.kts"))

val appVersion = Properties().apply {
    rootProject.file("app-version.properties").inputStream().use { load(it) }
}
val appVersionCode = appVersion.getProperty("versionCode")?.toIntOrNull()
    ?.takeIf { it in 1..2_100_000_000 }
    ?: error("app-version.properties must contain a valid positive versionCode.")
val appVersionName = appVersion.getProperty("versionName")?.takeIf { it.isNotBlank() }
    ?: error("app-version.properties must contain versionName.")
val defaultRef = providers.gradleProperty("defaultRef").getOrElse("staging").also {
    require(it == "staging" || it == "release") { "defaultRef must be staging or release." }
}
val officialRepoUrl = "https://github.com/SillyBunnyTeam/SillyBunny.git"
val officialUpdateManifestUrl =
    "https://github.com/SillyBunnyTeam/SillyBunny/releases/latest/download/android-update.json"
// SillyBunny's prerelease updater uses the official API outside debug fixtures.
val officialReleasesApiUrl = "https://api.github.com/repos/SillyBunnyTeam/SillyBunny/releases?per_page=20"

fun buildConfigString(value: String): String = "\"" + buildString {
    value.forEach { character ->
        when (character) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (character.code < 0x20 || character.code > 0x7e) {
                append("\\u" + character.code.toString(16).padStart(4, '0'))
            } else {
                append(character)
            }
        }
    }
} + "\""

val releaseSigningVariables = listOf(
    "ANDROID_KEYSTORE_B64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
)
val releaseSigningValues = releaseSigningVariables.associateWith {
    providers.environmentVariable(it).orNull
}
val hasReleaseSigning = releaseSigningValues.values.any { !it.isNullOrBlank() }
val releaseKeystoreFile = rootProject.file(".gradle/signing/release.keystore")
val prepareReleaseSigning = tasks.register("prepareReleaseSigning") {
    onlyIf { hasReleaseSigning }
    doLast {
        val missing = releaseSigningVariables.filter { releaseSigningValues[it].isNullOrBlank() }
        require(missing.isEmpty()) {
            "Release signing requires all of: ${releaseSigningVariables.joinToString()}."
        }
        val keystoreBytes = try {
            Base64.getDecoder().decode(
                releaseSigningValues.getValue("ANDROID_KEYSTORE_B64")!!.filterNot { it.isWhitespace() },
            )
        } catch (_: IllegalArgumentException) {
            error("ANDROID_KEYSTORE_B64 must be a Base64-encoded keystore.")
        }
        // Keep the ignored key outside build/ so `clean assembleRelease` cannot remove it mid-build.
        releaseKeystoreFile.parentFile.mkdirs()
        releaseKeystoreFile.writeBytes(keystoreBytes)
    }
}

tasks.matching { it.name == "validateSigningRelease" }.configureEach {
    dependsOn(prepareReleaseSigning)
}

android {
    namespace = "io.github.sillybunnyteam.sillybunny"
    compileSdk {
        version = release(37)
    }
    buildToolsVersion = "37.0.0"
    ndkVersion = "30.0.16248370"

    defaultConfig {
        applicationId = "io.github.sillybunnyteam.sillybunny"
        minSdk = 29
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "DEFAULT_REF", buildConfigString(defaultRef))
        buildConfigField("String", "REPO_URL", buildConfigString(officialRepoUrl))
        buildConfigField("String", "UPDATE_MANIFEST_URL", buildConfigString(officialUpdateManifestUrl))
        // Keep the prerelease endpoint pinned in production builds.
        buildConfigField("String", "RELEASES_API_URL", buildConfigString(officialReleasesApiUrl))
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = releaseSigningValues.getValue("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = releaseSigningValues.getValue("ANDROID_KEY_ALIAS")
                keyPassword = releaseSigningValues.getValue("ANDROID_KEY_PASSWORD")
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = false
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField(
                "String",
                "REPO_URL",
                buildConfigString(providers.gradleProperty("debugRepoUrl").getOrElse(officialRepoUrl)),
            )
            buildConfigField(
                "String",
                "UPDATE_MANIFEST_URL",
                buildConfigString(
                    providers.gradleProperty("debugUpdateManifestUrl").getOrElse(officialUpdateManifestUrl),
                ),
            )
            // Permit loopback release fixtures without changing the production endpoint.
            buildConfigField(
                "String",
                "RELEASES_API_URL",
                buildConfigString(
                    providers.gradleProperty("debugReleasesApiUrl").getOrElse(officialReleasesApiUrl),
                ),
            )
        }
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            if (providers.gradleProperty("includeX86_64").isPresent) {
                include("x86_64")
            }
            isUniversalApk = false
        }
    }

    packaging {
        jniLibs.useLegacyPackaging = true
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { test ->
                // Robolectric needs these on JDK 17+; they apply to the unit-test JVM only.
                test.jvmArgs(
                    listOf(
                        "java.base/java.lang",
                        "java.base/java.util",
                        "java.base/java.io",
                        "java.base/java.net",
                        "java.base/java.security",
                        "java.base/java.text",
                        "java.base/jdk.internal.access",
                        "java.desktop/java.awt.font",
                        "jdk.compiler/com.sun.tools.javac.api",
                    ).map { "--add-opens=$it=ALL-UNNAMED" },
                )
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.compose.foundation.layout)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.androidx.webkit)
    // Compose UI tests host composables in the library's debug-only ComponentActivity.
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    // Compose UI tests also run on Robolectric, so screens are testable without an emulator.
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.uiautomator)
}
