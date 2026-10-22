package io.github.sillybunnyteam.sillybunny.repair

import android.content.Context
import android.util.Log
import io.github.sillybunnyteam.sillybunny.BuildConfig
import io.github.sillybunnyteam.sillybunny.checkout.BrokenCheckouts
import io.github.sillybunnyteam.sillybunny.runtime.RuntimePaths
import io.github.sillybunnyteam.sillybunny.server.ServerHost
import io.github.sillybunnyteam.sillybunny.server.SetupJob
import io.github.sillybunnyteam.sillybunny.server.SetupState
import io.github.sillybunnyteam.sillybunny.update.UpdateChannel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.LinkOption
import java.nio.file.Paths
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Repair (plan §4.7), the recovery path that never deletes anything: stop the server, quiesce the
 * DocumentsProvider, move the checkout aside with [BrokenCheckouts.moveAside], then reinstall with
 * `install.sh --migrate-from <moved folder> --allow-git-source` through [ServerHost.runSetup].
 *
 * A [RepairRecord] is persisted before each step's side effect. Every retry migrates from the original
 * moved-aside folder, after moving any partial new checkout aside too, never from a partial checkout.
 *
 * Keep one instance per process, call [resumeOnLaunch] early in every launch (before choosing between
 * first run and starting the server), and start or retry only from a visible activity or a user action.
 * Blocking work runs on the injected dispatcher, never on the caller's thread.
 */
class RepairController internal constructor(
    context: Context,
    private val paths: RuntimePaths,
    private val serverHost: ServerHost,
    private val maintenance: ProviderMaintenance,
    private val installScript: File,
    private val isVisible: () -> Boolean,
    private val onServerStartDeferred: () -> Unit,
    private val store: RepairStore,
    private val defaultRef: String,
    private val clock: () -> Instant,
    private val dispatcher: CoroutineDispatcher,
    private val stopTimeoutMillis: Long,
    private val moveAside: (RuntimePaths, Instant) -> File,
) {
    /**
     * @param installScript the laid-out `install.sh`.
     * @param isVisible true while an activity of the app is started; called from background threads.
     * @param onServerStartDeferred Repair succeeded without starting the server, because nothing was visible
     *   or the start failed. Start it from the next visible screen ([startServer] does).
     * @param store the record; share one file with [LeftoverFolders] so it can protect the data's folder.
     */
    constructor(
        context: Context,
        paths: RuntimePaths,
        serverHost: ServerHost,
        maintenance: ProviderMaintenance,
        installScript: File,
        isVisible: () -> Boolean,
        onServerStartDeferred: () -> Unit = {},
        store: RepairStore = RepairStore(context),
        defaultRef: String = BuildConfig.DEFAULT_REF,
        clock: () -> Instant = Instant::now,
        dispatcher: CoroutineDispatcher = Dispatchers.IO,
        stopTimeoutMillis: Long = DEFAULT_STOP_TIMEOUT_MILLIS,
    ) : this(
        context, paths, serverHost, maintenance, installScript, isVisible, onServerStartDeferred, store,
        defaultRef, clock, dispatcher, stopTimeoutMillis, BrokenCheckouts::moveAside,
    )

    private val appContext: Context = context.applicationContext ?: context
    private val scope = CoroutineScope(
        SupervisorJob() + dispatcher + CoroutineExceptionHandler { _, failure ->
            Log.w(TAG, "Repair work stopped by an unexpected error", failure)
        },
    )
    private val mutableState = MutableStateFlow<RepairState>(RepairState.Idle)
    private val busy = AtomicBoolean(false)

    @Volatile
    private var activeJob: SetupJob? = null

    @Volatile
    private var cancelRequested = false

    val state: StateFlow<RepairState> = mutableState.asStateFlow()

    /** The user confirmed Repair. An unfinished Repair continues from its record instead. False while busy. */
    fun start(): Boolean = launch { begin(useDefaultRef = false) }

    /**
     * Retries a failed or interrupted Repair from the original moved-aside folder, installing the same branch
     * as before ([RepairState.Failed.ref]); the same as [start].
     */
    fun retry(): Boolean = start()

    /**
     * Retries like [retry], but installs the default branch instead of [RepairState.Failed.ref], for example
     * because the tracked branch was deleted upstream and every retry of it fails. The choice is persisted, so
     * later retries keep the default. False unless the current failure offers it ([RepairState.Failed.fallbackRef])
     * or while busy.
     */
    fun retryWithDefaultRef(): Boolean {
        val current = mutableState.value as? RepairState.Failed ?: return false
        if (current.fallbackRef == null) return false
        return launch { begin(useDefaultRef = true) }
    }

    /**
     * Stops the running reinstall (call it only behind a confirmation). The record stays ready for a retry.
     * False when no reinstall is running.
     */
    fun cancel(): Boolean {
        val current = mutableState.value
        if (current !is RepairState.Running || !current.canCancel || activeJob == null) return false
        cancelRequested = true
        mutableState.update { if (it is RepairState.Running) it.copy(cancelling = true) else it }
        scope.launch {
            try {
                serverHost.cancelSetup()
            } catch (failure: Exception) {
                Log.w(TAG, "Could not cancel the reinstall", failure)
            }
        }
        return true
    }

    /**
     * Finds an unfinished Repair after process death or activity re-creation. Call it early in every launch,
     * before choosing between first run and starting the server (plan §2.4 step 3). It blocks briefly, so
     * call it off the main thread, or use [resume]. Returns true when the Repair screen must be shown
     * instead: a reinstall is still running, or a moved-aside folder holds the data and needs a retry.
     * Without an unfinished Repair it also reopens a provider that a failed maintenance end left closed.
     */
    fun resumeOnLaunch(): Boolean {
        if (!busy.compareAndSet(false, true)) return needsScreen(mutableState.value)
        var release = true
        try {
            val known = mutableState.value
            if (known !is RepairState.Idle && known !is RepairState.Refused) return needsScreen(known)
            val found = try {
                reconcile()
            } catch (failure: IOException) {
                // Leftover folders stay protected while the record is unreadable; Repair refuses to start.
                Log.w(TAG, "Unreadable Repair record", failure)
                mutableState.value = RepairState.Refused(RepairRefusal.RECORD_UNREADABLE)
                return false
            }
            return when (found) {
                Reconciled.None -> {
                    // A refusal from before (an unreadable record, say) no longer applies.
                    mutableState.update { if (it is RepairState.Refused) RepairState.Idle else it }
                    false
                }
                is Reconciled.Unfinished -> {
                    publishUnfinished(found.record)
                    true
                }
                is Reconciled.Attach -> {
                    release = false
                    scope.launch { guarded { follow(found.record, found.job) } }
                    true
                }
            }
        } finally {
            if (release) busy.set(false)
        }
    }

    /** [resumeOnLaunch] on the controller's dispatcher. */
    suspend fun resume(): Boolean = withContext(dispatcher) { resumeOnLaunch() }

    /** Starts the server after a success that deferred it. Call it from a visible screen. */
    fun startServer(): Boolean {
        val current = mutableState.value as? RepairState.Succeeded ?: return false
        if (current.serverStarted) return false
        return try {
            serverHost.start(appContext)
            mutableState.value = current.copy(serverStarted = true)
            true
        } catch (failure: Exception) {
            Log.w(TAG, "Could not start the server", failure)
            false
        }
    }

    /**
     * Leaves a finished result. A failure whose data is still in a moved-aside folder is kept, so the next
     * launch offers the retry again; only a failure whose folder is gone forgets its record.
     */
    fun dismiss() {
        when (val current = mutableState.value) {
            is RepairState.Refused, is RepairState.Succeeded -> mutableState.value = RepairState.Idle
            is RepairState.Failed -> when {
                current.source == null -> mutableState.value = RepairState.Idle
                current.canRetry -> Unit
                else -> launch {
                    clearRecord()
                    mutableState.value = RepairState.Idle
                }
            }
            else -> Unit
        }
    }

    private fun launch(block: suspend () -> Unit): Boolean {
        if (!busy.compareAndSet(false, true)) return false
        scope.launch { guarded(block) }
        return true
    }

    /** Runs [block] holding [busy], which it releases; an unexpected error becomes a failure that keeps everything. */
    private suspend fun guarded(block: suspend () -> Unit) {
        try {
            block()
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            Log.w(TAG, "Repair stopped by an unexpected error", failure)
            failUnexpected()
        } finally {
            busy.set(false)
        }
    }

    /** [useDefaultRef]: this attempt and later retries install [defaultRef], whatever branch was tracked. */
    private suspend fun begin(useDefaultRef: Boolean) {
        val found = try {
            reconcile()
        } catch (failure: IOException) {
            Log.w(TAG, "Unreadable Repair record", failure)
            mutableState.value = RepairState.Refused(RepairRefusal.RECORD_UNREADABLE)
            return
        }
        val ref = if (useDefaultRef) defaultRef else null
        when (found) {
            Reconciled.None -> attempt(null, ref)
            is Reconciled.Unfinished -> attempt(found.record, ref)
            is Reconciled.Attach -> follow(found.record, found.job)
        }
    }

    /**
     * One attempt: a first Repair when [previous] is null, else a retry from `previous.source`. A non-null
     * [ref] replaces the branch the record would install; it is saved with the first step's record.
     */
    private suspend fun attempt(previous: RepairRecord?, ref: String?) {
        val source = previous?.source?.let { File(paths.filesDir, it) }
        publishStep(RepairStep.CHECKING, source)
        if (previous == null || source == null) {
            refusal()?.let {
                mutableState.value = RepairState.Refused(it)
                return
            }
        } else {
            retryProblem(source)?.let { return fail(if (ref == null) previous else previous.copy(ref = ref), it) }
        }
        var record = previous?.copy(phase = RepairPhase.STOPPING, failure = null, ref = ref ?: previous.ref)
            ?: RepairRecord(RepairPhase.STOPPING, clock(), ref = ref)

        // Step 2: stop the server, bounded. A server that does not stop aborts before anything moves.
        if (!save(record)) return fail(record, RepairFailure.RECORD_UNWRITABLE)
        publishStep(RepairStep.STOPPING_SERVER, source)
        if (!stopServer()) return fail(record, RepairFailure.STOP_TIMEOUT)

        // Step 3: quiesce external writers. Maintenance ends in the finally on every later path.
        record = record.copy(phase = RepairPhase.QUIESCING)
        if (!save(record)) return fail(record, RepairFailure.RECORD_UNWRITABLE)
        publishStep(RepairStep.PAUSING_FILE_ACCESS, source)
        val progress = Progress(record)
        val outcome = try {
            maintenance.beginMaintenance(appContext)
            progress.maintenanceBegun = true
            forgetOnSuccess(quiesced(progress))
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            Log.w(TAG, "Repair attempt stopped by an error", failure)
            val reason = if (progress.maintenanceBegun) RepairFailure.UNEXPECTED_ERROR else RepairFailure.MAINTENANCE_FAILED
            Outcome.Failure(progress.record, reason)
        } finally {
            activeJob = null
            endMaintenanceAndNotify()
        }
        finish(outcome)
    }

    /** Steps 4 and 5, with the provider in maintenance. */
    private suspend fun quiesced(progress: Progress): Outcome {
        var record = progress.record
        // runSetup needs a visible activity; checking before the rename keeps an invisible start from moving anything.
        if (!visible()) return Outcome.Failure(record, RepairFailure.NOT_VISIBLE)
        val source: File
        val sourceName = record.source
        if (sourceName == null) {
            // Step 4: move the checkout aside. The rename's instant and the folders already named after it are
            // persisted first, so a crash right after the rename can still tell which folder holds the data.
            val at = clock()
            record = record.copy(phase = RepairPhase.MOVING_ASIDE, movingAt = at, preexisting = namesStamped(at))
            if (!save(record)) return Outcome.Failure(record, RepairFailure.RECORD_UNWRITABLE)
            progress.record = record
            publishStep(RepairStep.MOVING_ASIDE, null)
            source = try {
                moveAside(paths, at)
            } catch (failure: IOException) {
                Log.w(TAG, "Could not move the checkout aside", failure)
                return Outcome.Failure(record, RepairFailure.MOVE_FAILED)
            }
            // From here every failure keeps the folder as the source; the disk record catches up below.
            record = record.copy(
                phase = RepairPhase.REINSTALLING,
                source = source.name,
                preexisting = emptyList(),
                movingAt = null,
                ref = record.ref ?: trackedRef(source),
            )
            progress.record = record
        } else {
            source = File(paths.filesDir, sourceName)
            val checkout = paths.checkoutDir.toPath()
            if (Files.exists(checkout, LinkOption.NOFOLLOW_LINKS)) {
                // A retry first moves the partial new checkout aside with the same helper; it is never a source.
                if (!Files.isDirectory(checkout, LinkOption.NOFOLLOW_LINKS)) {
                    return Outcome.Failure(record, RepairFailure.PARTIAL_NOT_DIRECTORY)
                }
                val at = clock()
                record = record.copy(phase = RepairPhase.MOVING_PARTIAL_ASIDE, movingAt = at, preexisting = namesStamped(at))
                if (!save(record)) return Outcome.Failure(record, RepairFailure.RECORD_UNWRITABLE)
                progress.record = record
                publishStep(RepairStep.MOVING_PARTIAL_ASIDE, source)
                val partial = try {
                    moveAside(paths, at)
                } catch (failure: IOException) {
                    Log.w(TAG, "Could not move the partial checkout aside", failure)
                    return Outcome.Failure(record, RepairFailure.PARTIAL_MOVE_FAILED)
                }
                record = record.copy(
                    phase = RepairPhase.REINSTALLING,
                    preexisting = emptyList(),
                    movingAt = null,
                    partials = (record.partials + partial.name).distinct(),
                )
                progress.record = record
            }
            if (record.ref == null) record = record.copy(ref = trackedRef(source))
        }

        // Step 5: reinstall, migrating from the folder that holds the data.
        record = record.copy(phase = RepairPhase.REINSTALLING)
        progress.record = record
        if (!save(record)) return Outcome.Failure(record, RepairFailure.RECORD_UNWRITABLE)
        val job = SetupJob(installScript, setupArgs(source, checkNotNull(record.ref)), paths.filesDir)
        cancelRequested = false
        val accepted = try {
            serverHost.runSetup(appContext, job)
        } catch (failure: Exception) {
            Log.w(TAG, "The server host refused the reinstall", failure)
            false
        }
        if (!accepted) return Outcome.Failure(record, RepairFailure.SETUP_REFUSED)
        activeJob = job
        mutableState.value = RepairState.Running(RepairStep.REINSTALLING, source, emptyList(), ref = record.ref)
        return awaitSetup(record) { it === job }
    }

    /** Re-attaches to a reinstall that is still running (or just finished) in this process, then finishes it. */
    private suspend fun follow(record: RepairRecord, job: SetupJob) {
        val source = File(paths.filesDir, checkNotNull(record.source))
        cancelRequested = false
        activeJob = job
        val lines = (serverHost.setup.value as? SetupState.Running)?.lines.orEmpty()
        mutableState.value = RepairState.Running(RepairStep.REINSTALLING, source, lines, ref = record.ref)
        val outcome = try {
            forgetOnSuccess(awaitSetup(record) { it === job || it.args == job.args })
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            Log.w(TAG, "Lost the reinstall", failure)
            Outcome.Failure(record, RepairFailure.UNEXPECTED_ERROR)
        } finally {
            activeJob = null
            endMaintenanceAndNotify()
        }
        finish(outcome)
    }

    /**
     * Follows the accepted job until it finishes. Any other setup state means the job is gone: the server
     * host publishes `Finished` for a job and keeps it until the next job starts.
     */
    private suspend fun awaitSetup(record: RepairRecord, matches: (SetupJob) -> Boolean): Outcome {
        val source = File(paths.filesDir, checkNotNull(record.source))
        val last = serverHost.setup.first { setup ->
            if (setup is SetupState.Running && matches(setup.job)) {
                mutableState.update { current ->
                    val cancelling = (current as? RepairState.Running)?.cancelling ?: false
                    RepairState.Running(RepairStep.REINSTALLING, source, setup.lines, cancelling, record.ref)
                }
                false
            } else {
                true
            }
        }
        if (last !is SetupState.Finished || !matches(last.job)) return Outcome.Failure(record, RepairFailure.INTERRUPTED)
        val lines = last.lines
        return when {
            last.exitCode == 0 && CheckoutChecks.isGitCheckout(paths.checkoutDir) -> Outcome.Success(record, lines)
            cancelRequested -> Outcome.Failure(record, RepairFailure.CANCELLED, lines, last.exitCode)
            last.exitCode == 0 -> Outcome.Failure(record, RepairFailure.NOT_A_CHECKOUT, lines, last.exitCode)
            else -> Outcome.Failure(record, RepairFailure.INSTALL_FAILED, lines, last.exitCode)
        }
    }

    /**
     * Forgets the record of a successful reinstall. Call it while the provider is still in maintenance, so
     * nothing can write to the new checkout before the record stops pointing a retry at the moved folder.
     * A record that cannot be forgotten turns the success into a RECORD_UNWRITABLE failure: the server stays
     * stopped, and a retry moves the new checkout aside and migrates from the same folder again.
     */
    private fun forgetOnSuccess(outcome: Outcome): Outcome {
        if (outcome !is Outcome.Success || clearRecord()) return outcome
        return Outcome.Failure(outcome.record, RepairFailure.RECORD_UNWRITABLE, outcome.lines, exitCode = 0)
    }

    private fun finish(outcome: Outcome) {
        when (outcome) {
            is Outcome.Failure -> fail(outcome.record, outcome.reason, outcome.lines, outcome.exitCode)
            is Outcome.Success -> succeed(outcome.record, outcome.lines)
        }
    }

    /** Step 6, once [forgetOnSuccess] cleared the record and maintenance ended. Keeps the moved-aside folder. */
    private fun succeed(record: RepairRecord, lines: List<String>) {
        val source = File(paths.filesDir, checkNotNull(record.source))
        publishStep(RepairStep.STARTING_SERVER, source)
        val started = visible() && try {
            serverHost.start(appContext)
            true
        } catch (failure: Exception) {
            Log.w(TAG, "Could not start the server after Repair", failure)
            false
        }
        if (!started) {
            try {
                onServerStartDeferred()
            } catch (failure: Exception) {
                Log.w(TAG, "The deferred-start callback failed", failure)
            }
        }
        mutableState.value = RepairState.Succeeded(source, started, lines)
    }

    /** Step 7: keeps everything. A record whose data has moved stays, ready for a retry. */
    private fun fail(record: RepairRecord, reason: RepairFailure, lines: List<String> = emptyList(), exitCode: Int? = null) {
        val sourceName = record.source ?: movedSource(record)
        if (sourceName == null) {
            // Nothing moved: the checkout is where it was, so there is nothing to resume.
            clearRecord()
            mutableState.value = RepairState.Failed(reason, null, lines, exitCode, canRetry = true)
            return
        }
        val source = File(paths.filesDir, sourceName)
        val ref = refFor(record, source)
        save(
            record.copy(
                phase = RepairPhase.FAILED,
                source = sourceName,
                ref = ref,
                failure = reason,
                preexisting = emptyList(),
                movingAt = null,
                partials = (record.partials + listOfNotNull(movedPartial(record, sourceName))).distinct(),
            ),
        )
        publishFailed(reason, source, ref, lines, exitCode)
    }

    private fun publishFailed(reason: RepairFailure, source: File, ref: String?, lines: List<String>, exitCode: Int?) {
        val canRetry = isDirectory(source)
        val fallbackRef = if (canRetry && ref != null && ref != defaultRef) defaultRef else null
        mutableState.value = RepairState.Failed(reason, source, lines, exitCode, canRetry, ref, fallbackRef)
    }

    private fun failUnexpected() {
        activeJob = null
        endMaintenanceAndNotify()
        val record = try {
            store.load()
        } catch (failure: IOException) {
            null
        }
        if (record == null) {
            mutableState.value = RepairState.Failed(RepairFailure.UNEXPECTED_ERROR, null, emptyList(), null, true)
        } else {
            fail(record, RepairFailure.UNEXPECTED_ERROR)
        }
    }

    private fun publishUnfinished(record: RepairRecord) {
        val source = File(paths.filesDir, checkNotNull(record.source))
        publishFailed(record.failure ?: RepairFailure.INTERRUPTED, source, record.ref, emptyList(), null)
    }

    /**
     * Turns the persisted record into what this process must do: nothing (no record, or one that describes
     * no move, which is forgotten), follow a reinstall that is still known to the server host, or offer a
     * retry of an unfinished Repair. Ends provider maintenance unless a reinstall is still being followed.
     */
    @Throws(IOException::class)
    private fun reconcile(): Reconciled {
        val record = store.load()
        if (record == null) {
            // Nothing unfinished: reopen a provider that a failed end left in maintenance (a no-op otherwise).
            endMaintenanceQuietly()
            return Reconciled.None
        }
        val sourceName = record.source ?: movedSource(record)
        if (sourceName == null) {
            endMaintenanceAndNotify()
            clearRecord()
            return Reconciled.None
        }
        val source = File(paths.filesDir, sourceName)
        val ref = record.ref
        if (record.phase == RepairPhase.REINSTALLING && ref != null) {
            val job = when (val setup = serverHost.setup.value) {
                is SetupState.Running -> setup.job
                is SetupState.Finished -> setup.job
                SetupState.Idle -> null
            }
            if (job != null && job.args == setupArgs(source, ref)) return Reconciled.Attach(record, job)
        }
        // The reinstall is gone (process death) or an attempt stopped between steps.
        endMaintenanceAndNotify()
        val failure = if (record.phase == RepairPhase.FAILED) record.failure else null
        val unfinished = record.copy(
            phase = RepairPhase.FAILED,
            source = sourceName,
            ref = refFor(record, source),
            failure = failure ?: RepairFailure.INTERRUPTED,
            preexisting = emptyList(),
            movingAt = null,
            partials = (record.partials + listOfNotNull(movedPartial(record, sourceName))).distinct(),
        )
        if (unfinished != record) save(unfinished)
        return Reconciled.Unfinished(unfinished)
    }

    /** The data's folder made by an interrupted first rename, or null when that rename did not happen. */
    private fun movedSource(record: RepairRecord): String? =
        if (record.phase == RepairPhase.MOVING_ASIDE) renamed(record) else null

    /** The partial checkout an interrupted retry moved aside, if it did. */
    private fun movedPartial(record: RepairRecord, sourceName: String): String? =
        if (record.phase == RepairPhase.MOVING_PARTIAL_ASIDE) renamed(record)?.takeIf { it != sourceName } else null

    private fun renamed(record: RepairRecord): String? {
        // Records always carry the instant; without it only a missing checkout proves the rename happened.
        if (record.movingAt == null && Files.exists(paths.checkoutDir.toPath(), LinkOption.NOFOLLOW_LINKS)) return null
        return brokenNames().lastOrNull { record.mayHaveMade(it) }
    }

    private fun namesStamped(at: Instant): List<String> = brokenNames().filter { stampedAt(it, at) }

    private fun brokenNames(): List<String> = BrokenCheckouts.list(paths).map { it.name }

    private fun refusal(): RepairRefusal? {
        val checkout = paths.checkoutDir.toPath()
        if (!Files.exists(checkout, LinkOption.NOFOLLOW_LINKS)) return RepairRefusal.CHECKOUT_MISSING
        if (!Files.isDirectory(checkout, LinkOption.NOFOLLOW_LINKS)) return RepairRefusal.CHECKOUT_NOT_DIRECTORY
        if (serverHost.setup.value is SetupState.Running) return RepairRefusal.SETUP_BUSY
        return sourceProblem(paths.checkoutDir)
    }

    private fun retryProblem(source: File): RepairFailure? {
        if (!isDirectory(source)) return RepairFailure.SOURCE_MISSING
        if (serverHost.setup.value is SetupState.Running) return RepairFailure.SETUP_BUSY
        return sourceProblem(source)?.let {
            Log.w(TAG, "The moved-aside folder can no longer be migrated: $it")
            RepairFailure.SOURCE_INVALID
        }
    }

    /** The install.sh refusals that would otherwise only surface after the rename (plan §4.7 step 3). */
    private fun sourceProblem(source: File): RepairRefusal? {
        if (!CheckoutChecks.isSillyBunny(source)) return RepairRefusal.NOT_SILLYBUNNY
        val root = try {
            DataRoot.read(source)
        } catch (failure: IOException) {
            return RepairRefusal.CONFIG_UNREADABLE
        }
        if (!DataRoot.isAbsolute(root)) {
            return if (DataRoot.escapesCheckout(root)) RepairRefusal.DATA_ROOT_OUTSIDE_CHECKOUT else null
        }
        // An absolute root is reused, not copied; inside the checkout the rename would strand it: the copied
        // config would point into the new, empty checkout.
        val inside = try {
            PathContainment.isWithin(Paths.get(root), paths.checkoutDir.toPath())
        } catch (failure: InvalidPathException) {
            return RepairRefusal.CONFIG_UNREADABLE
        }
        return if (inside) RepairRefusal.DATA_ROOT_INSIDE_CHECKOUT else null
    }

    /** The exact `install.sh` arguments (plan §4.7 step 3). */
    internal fun setupArgs(source: File, ref: String): List<String> = listOf(
        "--no-start",
        "--dir",
        paths.checkoutDir.path,
        "--ref",
        ref,
        "--use-node",
        "--migrate-from",
        source.path,
        "--allow-git-source",
    )

    /** The branch the source tracked, else [defaultRef] (plan §4.7 step 3). */
    private fun trackedRef(source: File): String = safeRef(UpdateChannel.trackedBranch(source, defaultRef))

    /** The record's branch, else the one its source tracked; null while the source is not a directory. */
    private fun refFor(record: RepairRecord, source: File): String? =
        record.ref ?: if (isDirectory(source)) trackedRef(source) else null

    // install.sh rejects a --ref that is empty or starts with '-', so such a branch falls back to the default.
    private fun safeRef(ref: String): String = if (ref.isEmpty() || ref.startsWith('-')) defaultRef else ref

    private fun stopServer(): Boolean = try {
        serverHost.stop(stopTimeoutMillis)
    } catch (failure: Exception) {
        Log.w(TAG, "Stopping the server failed", failure)
        false
    }

    private fun visible(): Boolean = try {
        isVisible()
    } catch (failure: Exception) {
        Log.w(TAG, "Visibility check failed", failure)
        false
    }

    private fun endMaintenanceAndNotify() {
        endMaintenanceQuietly()
        try {
            maintenance.notifyRootsChanged(appContext)
        } catch (failure: Exception) {
            Log.w(TAG, "Notifying provider roots failed", failure)
        }
    }

    private fun endMaintenanceQuietly() {
        try {
            maintenance.endMaintenance(appContext)
        } catch (failure: Exception) {
            Log.w(TAG, "Ending provider maintenance failed", failure)
        }
    }

    private fun save(record: RepairRecord): Boolean = try {
        store.save(record)
        true
    } catch (failure: IOException) {
        Log.w(TAG, "Could not persist the Repair record", failure)
        false
    }

    private fun clearRecord(): Boolean = try {
        store.clear()
        true
    } catch (failure: IOException) {
        Log.w(TAG, "Could not clear the Repair record", failure)
        false
    }

    private fun publishStep(step: RepairStep, source: File?) {
        mutableState.value = RepairState.Running(step, source, emptyList())
    }

    private fun needsScreen(state: RepairState): Boolean = when (state) {
        is RepairState.Running -> true
        is RepairState.Failed -> state.source != null
        else -> false
    }

    private fun isDirectory(file: File): Boolean = Files.isDirectory(file.toPath(), LinkOption.NOFOLLOW_LINKS)

    private class Progress(var record: RepairRecord) {
        var maintenanceBegun = false
    }

    private sealed interface Outcome {
        data class Failure(
            val record: RepairRecord,
            val reason: RepairFailure,
            val lines: List<String> = emptyList(),
            val exitCode: Int? = null,
        ) : Outcome

        data class Success(val record: RepairRecord, val lines: List<String>) : Outcome
    }

    private sealed interface Reconciled {
        data object None : Reconciled

        data class Unfinished(val record: RepairRecord) : Reconciled

        data class Attach(val record: RepairRecord, val job: SetupJob) : Reconciled
    }

    companion object {
        const val DEFAULT_STOP_TIMEOUT_MILLIS = 15_000L
        private const val TAG = "SillyBunnyRepair"
    }
}
