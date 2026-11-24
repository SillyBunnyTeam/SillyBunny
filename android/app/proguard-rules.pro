# Preserve file names and line numbers so Share Logs and crash records stay actionable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Preserve any WebView @JavascriptInterface methods if added; the transfer bridge uses AndroidX
# WebMessageListener, whose boundary interfaces are kept by androidx.webkit's consumer rules.
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Manifest entrypoints instantiated reflectively by the Android framework.
-keep class io.github.sillybunnyteam.sillybunny.MainActivity {
    public <init>();
}
-keep class io.github.sillybunnyteam.sillybunny.ServerService {
    public <init>();
}
-keep class io.github.sillybunnyteam.sillybunny.DataDocumentsProvider {
    public <init>();
}
-keep class io.github.sillybunnyteam.sillybunny.PackageReplacedReceiver {
    public <init>();
}
-keep class io.github.sillybunnyteam.sillybunny.update.InstallStatusReceiver {
    public <init>();
}
# SmokeHookProvider exists only in the debug source set; suppress unmatched-class notes in release.
-dontnote io.github.sillybunnyteam.sillybunny.smoke.**
-keep class io.github.sillybunnyteam.sillybunny.smoke.SmokeHookProvider {
    public <init>();
}

# ViewModelProvider.AndroidViewModelFactory instantiates AppUpdater(Application) via reflection.
-keepclassmembers class * extends androidx.lifecycle.AndroidViewModel {
    public <init>(android.app.Application);
}
-keep class io.github.sillybunnyteam.sillybunny.update.AppUpdater {
    public <init>(android.app.Application);
}

# Keep enum values()/valueOf(String) for persisted state and JSON enum lookups; runtime/update JSON
# parsers (StrictJson, RuntimeManifest, InstalledRuntime, UpdateManifest, BridgeProtocol) use org.json
# directly without reflective model binding.
-keepclassmembers enum io.github.sillybunnyteam.sillybunny.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
