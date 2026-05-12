const DEFAULT_DEBOUNCE_MS = 1200;

export function createDocumentJobQueue(deps = {}) {
  const {
    debounceMs = DEFAULT_DEBOUNCE_MS,
    logger = console
  } = deps;

  const pendingByDoc = new Map();
  const runningByDoc = new Map();
  const runningMetaByDoc = new Map();
  const timers = new Map();

  function getPendingBucket(docId) {
    if (!pendingByDoc.has(docId)) {
      pendingByDoc.set(docId, new Map());
    }
    return pendingByDoc.get(docId);
  }

  async function executeDocJobs(docId) {
    const bucket = pendingByDoc.get(docId);
    if (!bucket || bucket.size === 0) {
      pendingByDoc.delete(docId);
      return;
    }
    pendingByDoc.delete(docId);
    for (const job of bucket.values()) {
      if (!runningMetaByDoc.has(docId)) {
        runningMetaByDoc.set(docId, new Map());
      }
      runningMetaByDoc.get(docId).set(job.jobType, job.dedupeKey);
      try {
        await job.run();
      } catch (error) {
        if (typeof logger?.warn === "function") {
          logger.warn(
            `[document-job-queue] job failed doc=${docId} type=${job.jobType}: ${error?.message ?? error}`
          );
        }
      } finally {
        const docMeta = runningMetaByDoc.get(docId);
        docMeta?.delete(job.jobType);
        if ((docMeta?.size ?? 0) === 0) {
          runningMetaByDoc.delete(docId);
        }
      }
    }
  }

  function runDoc(docId) {
    const previous = runningByDoc.get(docId) ?? Promise.resolve();
    const next = previous
      .catch(() => null)
      .then(() => executeDocJobs(docId))
      .finally(() => {
        if ((pendingByDoc.get(docId)?.size ?? 0) > 0) {
          schedule(docId);
        } else {
          runningByDoc.delete(docId);
        }
      });
    runningByDoc.set(docId, next);
  }

  function schedule(docId) {
    const existing = timers.get(docId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(docId);
      runDoc(docId);
    }, Math.max(50, Number(debounceMs) || DEFAULT_DEBOUNCE_MS));
    if (typeof timer?.unref === "function") timer.unref();
    timers.set(docId, timer);
  }

  function enqueue({ docId, jobType, dedupeKey, run }) {
    const normalizedDocId = String(docId ?? "").trim();
    const normalizedJobType = String(jobType ?? "").trim();
    if (!normalizedDocId || !normalizedJobType || typeof run !== "function") return false;
    const bucket = getPendingBucket(normalizedDocId);
    const previous = bucket.get(normalizedJobType) ?? null;
    const runningDedupeKey = runningMetaByDoc.get(normalizedDocId)?.get(normalizedJobType) ?? null;
    if (previous && String(previous.dedupeKey ?? "") === String(dedupeKey ?? "")) {
      return false;
    }
    if (runningDedupeKey && String(runningDedupeKey) === String(dedupeKey ?? "")) {
      return false;
    }
    bucket.set(normalizedJobType, {
      docId: normalizedDocId,
      jobType: normalizedJobType,
      dedupeKey: String(dedupeKey ?? "").trim(),
      run
    });
    schedule(normalizedDocId);
    return true;
  }

  function getSnapshot() {
    return {
      docs_pending: pendingByDoc.size,
      docs_running: runningByDoc.size,
      pending_jobs: Array.from(pendingByDoc.entries()).map(([docId, jobs]) => ({
        doc_id: docId,
        job_types: Array.from(jobs.keys())
      })),
      running_jobs: Array.from(runningMetaByDoc.entries()).map(([docId, jobs]) => ({
        doc_id: docId,
        job_types: Array.from(jobs.keys())
      }))
    };
  }

  return {
    enqueue,
    getSnapshot
  };
}
