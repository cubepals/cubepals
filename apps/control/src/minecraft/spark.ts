// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * spark, the profiler Paper bundles and enables at every start, starts by default a background
 * profiler that samples the server for as long as it runs, whether or not anyone ever looks. On a
 * server's one CPU that is about a third of what an idle Paper server spends: Paper 26.3 idle with
 * nobody on, one CPU, sampled for five minutes in two pairs of runs, took 2.2 and 2.6% of the CPU
 * with it and 1.3 and 1.8% without, and about 90 MiB less memory without.
 *
 * spark reads each setting from a Java property, then an environment variable, then its
 * `plugins/spark/config.json` (spark's `SparkPlatform`, `RuntimeConfiguration`). The file can't
 * carry it: spark writes `"backgroundProfiler": true` into it itself the first time it starts, so
 * every server that ran Paper already has a file saying so that nobody chose. The variable says
 * it without writing over anything. `/spark` still works for an owner who wants to profile: only
 * the profiler nobody started is off.
 *
 * Not for whether spark loads at all (Paper's `paper-global.yml`), or any other setting of spark's.
 */

/** spark's `backgroundProfiler` setting as its environment variable says it (`SPARK_` and the key). */
const BACKGROUND_PROFILER = 'SPARK_BACKGROUNDPROFILER'

/** The shell line that turns the background profiler off on a server that runs Paper. */
export const SPARK_STEP = `if [ "$TYPE" = PAPER ]; then export ${BACKGROUND_PROFILER}=false; fi;`
