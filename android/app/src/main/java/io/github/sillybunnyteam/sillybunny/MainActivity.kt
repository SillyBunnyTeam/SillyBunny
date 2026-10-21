package io.github.sillybunnyteam.sillybunny

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.sillybunnyteam.sillybunny.update.UpdateActivityHook

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep SillyBunny's asynchronous updater separate from server startup and later activity work.
        val updates = UpdateActivityHook(this).also { it.attach() }
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = colorResource(R.color.warm_signal),
                    onPrimary = colorResource(R.color.shadow_ink),
                    background = colorResource(R.color.charcoal_canvas),
                    onBackground = colorResource(R.color.linen_text),
                    surface = colorResource(R.color.charcoal_canvas),
                    onSurface = colorResource(R.color.linen_text),
                ),
            ) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Box(
                        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = stringResource(R.string.scaffold_message),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                }
                // The updater owns its lifecycle, source-approval return, and transient dialog.
                updates.Dialog()
            }
        }
    }
}
