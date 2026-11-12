package io.github.sillybunnyteam.sillybunny.web.files

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import io.github.sillybunnyteam.sillybunny.web.downloads.FileNames

internal enum class PickerKind { OPEN, OPEN_MULTIPLE, FOLDER, SAVE }

/** One SAF request for a chooser call, and whether its result must also grant write access. */
internal class PickerRequest(val intent: Intent, val kind: PickerKind, val requireWrite: Boolean)

/** Builds the SAF intent for a `FileChooserParams` request (plan §4.5). */
internal object PickerRequests {
    // WebChromeClient.FileChooserParams values. MODE_OPEN_FOLDER and the permission modes are new in
    // API 37, so they are mirrored here and honored only when the device runs API 37 or later.
    const val MODE_OPEN = 0
    const val MODE_OPEN_MULTIPLE = 1
    const val MODE_OPEN_FOLDER = 2
    const val MODE_SAVE = 3
    const val PERMISSION_MODE_READ = 0
    const val PERMISSION_MODE_READ_WRITE = 1
    const val FOLDER_MODES_API = 37

    /** Null for a mode this device cannot serve; the caller then cancels the request. */
    fun create(
        mode: Int,
        permissionMode: Int,
        acceptTypes: Array<String>?,
        filenameHint: String?,
        sdk: Int,
    ): PickerRequest? {
        val readWrite = sdk >= FOLDER_MODES_API && permissionMode == PERMISSION_MODE_READ_WRITE
        return when (mode) {
            MODE_OPEN, MODE_OPEN_MULTIPLE -> {
                val filter = AcceptTypes.filterFor(acceptTypes)
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(filter.type)
                if (filter.extraMimeTypes.isNotEmpty()) {
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, filter.extraMimeTypes.toTypedArray())
                }
                val multiple = mode == MODE_OPEN_MULTIPLE
                if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                PickerRequest(intent, if (multiple) PickerKind.OPEN_MULTIPLE else PickerKind.OPEN, readWrite)
            }
            MODE_OPEN_FOLDER -> if (sdk >= FOLDER_MODES_API) {
                PickerRequest(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PickerKind.FOLDER, readWrite)
            } else {
                null
            }
            MODE_SAVE -> {
                val filter = AcceptTypes.filterFor(acceptTypes)
                val declared = filter.type.takeUnless { '*' in it }
                val name = FileNames.withExtensionFor(FileNames.sanitize(filenameHint), declared)
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(FileNames.saveMime(name))
                    .putExtra(Intent.EXTRA_TITLE, name)
                PickerRequest(intent, PickerKind.SAVE, requireWrite = true)
            }
            else -> null
        }
    }
}

/** Turns a picker result into the URIs the page may receive (plan §4.5). */
internal object PickerResults {
    /** `data` first, then every `ClipData` item, without duplicates. */
    fun uris(data: Intent?): List<Uri> {
        if (data == null) return emptyList()
        val result = LinkedHashSet<Uri>()
        data.data?.let(result::add)
        val clip = data.clipData
        if (clip != null) {
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(result::add)
        }
        return result.toList()
    }

    /** The URIs to hand to the page, or null to cancel. One unacceptable URI rejects the result. */
    fun accept(resultCode: Int, data: Intent?, request: PickerRequest, policy: ContentUriPolicy): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || data == null) return null
        val all = uris(data)
        val chosen = if (request.kind == PickerKind.OPEN_MULTIPLE) all else all.take(1)
        if (chosen.isEmpty()) return null
        val needed = ContentUriPolicy.READ or if (request.requireWrite) ContentUriPolicy.WRITE else 0
        for (uri in chosen) {
            if (!policy.isForeignContent(uri)) return null
            if (!policy.hasGrant(uri, data.flags, needed)) return null
            if (request.kind == PickerKind.FOLDER && !DocumentsContract.isTreeUri(uri)) return null
        }
        return chosen.toTypedArray()
    }
}
