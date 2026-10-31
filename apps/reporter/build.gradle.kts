// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Built with JDK 21 for Java 17's bytecode: Paper 1.20.1, the oldest Cubepals offers, runs on 17.
// Compiled against that Paper's API, so it loads on every Paper Cubepals offers; the events only
// newer Paper has are found by name as it starts (Listeners.java).

import org.gradle.api.tasks.testing.TestDescriptor
import org.gradle.api.tasks.testing.TestListener
import org.gradle.api.tasks.testing.TestResult

plugins {
    java
    jacoco
    id("info.solidsoft.pitest") version "1.19.0"
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.20.1-R0.1-SNAPSHOT")
    // The tests run against a Paper that has the configuration events, built for Java 21.
    testImplementation("io.papermc.paper:paper-api:1.21.8-R0.1-SNAPSHOT")
    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

tasks.compileJava {
    options.release = 17
}

tasks.compileTestJava {
    options.release = 21
}

tasks.test {
    useJUnitPlatform()
    addTestListener(object : TestListener {
        override fun beforeSuite(suite: TestDescriptor) {}
        override fun beforeTest(test: TestDescriptor) {}
        override fun afterTest(test: TestDescriptor, result: TestResult) {}
        override fun afterSuite(suite: TestDescriptor, result: TestResult) {
            if (suite.parent == null) {
                check(result.testCount > 0) { "Reporter tests must execute at least one case" }
                check(result.skippedTestCount == 0L) { "Reporter tests must not skip or abort cases" }
            }
        }
    })
}

jacoco {
    toolVersion = "0.8.16"
}

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required = true
        html.required = true
    }
}

pitest {
    pitestVersion.set("1.30.1")
    junit5PluginVersion.set("1.2.3")
    // The trusted CI controller supplies every changed class, or every class on scheduled runs.
    targetClasses.set(providers.gradleProperty("qualityClasses")
            .map { it.split(",").toSet() }.orElse(setOf("blockly.reporter.*")))
    // PIT otherwise inherits targetClasses for test discovery, which loses tests on narrow runs.
    targetTests.set(setOf("*"))
    outputFormats.set(setOf("XML", "HTML"))
    timestampedReports.set(false)
    threads.set(2)
    failWhenNoMutations.set(true)
}

// CI verifies the XML independently, including per-file floors and the measured base ratchet.
// Keep report production separate so a missing baseline never quietly becomes a passing gate.
tasks.register("qualityReports") {
    dependsOn(tasks.jacocoTestReport, tasks.pitest)
}

// The same bytes from the same source, so the control plane stores one copy by its digest.
tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

tasks.jar {
    archiveFileName = "cubepals-reporter.jar"
}
