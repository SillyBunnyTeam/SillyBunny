package io.github.sillybunnyteam.sillybunny.settings

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RuntimeVersionsTest {
    private fun parse(json: String) = AssetRuntimeVersions.parse(json.toByteArray())

    @Test
    fun readsVersionsInRuntimeOrder() {
        val versions = parse(
            """{"schema":1,"versions":{"bash":"5.3.20","git":"2.56.0","extra":"1","npm":"11.6.2","node":"24.22.0"}}""",
        )
        assertEquals(
            listOf(
                RuntimeVersion("node", "24.22.0"),
                RuntimeVersion("npm", "11.6.2"),
                RuntimeVersion("git", "2.56.0"),
                RuntimeVersion("bash", "5.3.20"),
                RuntimeVersion("extra", "1"),
            ),
            versions,
        )
    }

    @Test
    fun skipsUnusableValuesAndUnknownManifests() {
        assertEquals(
            listOf(RuntimeVersion("node", "24.22.0")),
            parse("""{"schema":1,"versions":{"node":"24.22.0","npm":7,"git":"","bash":null}}"""),
        )
        assertEquals(emptyList<RuntimeVersion>(), parse("""{"schema":2,"versions":{"node":"24.22.0"}}"""))
        assertEquals(emptyList<RuntimeVersion>(), parse("""{"versions":{"node":"24.22.0"}}"""))
        assertEquals(emptyList<RuntimeVersion>(), parse("""{"schema":1}"""))
        assertEquals(emptyList<RuntimeVersion>(), parse("{"))
    }

    @Test
    fun aBuildWithoutTheManifestShowsNoVersions() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals(emptyList<RuntimeVersion>(), AssetRuntimeVersions(context.assets).read())
    }
}
