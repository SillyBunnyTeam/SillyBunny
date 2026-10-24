package io.github.sillybunnyteam.sillybunny.runtime

import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater

/** Writes ZIP archives field by field, so tests can produce entries that java.util.zip refuses to write. */
internal object TestZip {
    const val STORED = 0
    const val DEFLATED = 8
    const val FILE_MODE = 0x81A4L
    const val DIRECTORY_MODE = 0x41EDL
    const val LINK_MODE = 0xA1FFL
    const val FIFO_MODE = 0x11A4L

    class Item(
        val name: String,
        val data: ByteArray = ByteArray(0),
        val method: Int = DEFLATED,
        val mode: Long = if (name.endsWith('/')) DIRECTORY_MODE else FILE_MODE,
        val flags: Int = 0,
        val crc: Long? = null,
        val size: Long? = null,
        val payload: ByteArray? = null,
        val localName: String = name,
    )

    fun file(name: String, text: String, method: Int = DEFLATED) = Item(name, text.toByteArray(Charsets.UTF_8), method)

    fun build(vararg items: Item): ByteArray = build(items.toList())

    fun build(items: List<Item>, trailer: ByteArray = ByteArray(0), entryCount: Int = items.size): ByteArray {
        val out = ByteArrayOutputStream()
        val central = ByteArrayOutputStream()
        items.forEach { item ->
            val compressed = item.payload ?: if (item.method == DEFLATED) deflate(item.data) else item.data
            val crc = item.crc ?: CRC32().apply { update(item.data) }.value
            val size = item.size ?: item.data.size.toLong()
            val offset = out.size().toLong()
            val name = item.name.toByteArray(Charsets.UTF_8)
            val localName = item.localName.toByteArray(Charsets.UTF_8)
            out.u32(0x04034b50L)
            out.u16(20)
            out.u16(item.flags)
            out.u16(item.method)
            out.u16(0)
            out.u16(0x21)
            out.u32(crc)
            out.u32(compressed.size.toLong())
            out.u32(size)
            out.u16(localName.size)
            out.u16(0)
            out.write(localName)
            out.write(compressed)

            central.u32(0x02014b50L)
            central.u16(0x031E)
            central.u16(20)
            central.u16(item.flags)
            central.u16(item.method)
            central.u16(0)
            central.u16(0x21)
            central.u32(crc)
            central.u32(compressed.size.toLong())
            central.u32(size)
            central.u16(name.size)
            repeat(4) { central.u16(0) }
            central.u32(item.mode shl 16)
            central.u32(offset)
            central.write(name)
        }
        val directoryOffset = out.size().toLong()
        val directory = central.toByteArray()
        out.write(directory)
        out.u32(0x06054b50L)
        out.u16(0)
        out.u16(0)
        out.u16(entryCount)
        out.u16(entryCount)
        out.u32(directory.size.toLong())
        out.u32(directoryOffset)
        out.u16(0)
        out.write(trailer)
        return out.toByteArray()
    }

    fun record(bytes: ByteArray, files: Int, contentBytes: Long, version: String = "11.19.1") =
        NpmArchiveRecord(version, RuntimeManifest.sha256(bytes), bytes.size.toLong(), files, contentBytes)

    fun deflate(data: ByteArray): ByteArray {
        val deflater = Deflater(Deflater.DEFAULT_COMPRESSION, true)
        deflater.setInput(data)
        deflater.finish()
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (!deflater.finished()) out.write(buffer, 0, deflater.deflate(buffer))
        deflater.end()
        return out.toByteArray()
    }

    private fun ByteArrayOutputStream.u16(value: Int) {
        write(value and 0xFF)
        write((value ushr 8) and 0xFF)
    }

    private fun ByteArrayOutputStream.u32(value: Long) {
        u16((value and 0xFFFF).toInt())
        u16(((value ushr 16) and 0xFFFF).toInt())
    }
}
