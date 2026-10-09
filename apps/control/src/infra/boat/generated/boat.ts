// Generated from infra/boat/boat.openapi.json (sha256 172b55a4eadcc81e543d1d57b32e20f346a993d53be2343c715da67b85b5d3b9) by tools/openapi.
// Do not edit. Regenerate with `bun run openapi:generate`; update the spec with `bun run openapi:update boat`.

export interface paths {
    "/account/data-retention": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get account data-retention policy
         * @description Returns the current zero-data-retention policy. Per-Boat API keys cannot access this account-wide setting. Responses are never cached.
         */
        get: operations["getDataRetention"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update account data-retention policy
         * @description Requires an interactive sandbox session; API keys and legacy permanent tokens are refused. Enabling requires the exact confirmation phrase `delete archived sandbox data`. Disabling affects future archives only and cannot cancel deletion operations already accepted.
         */
        patch: operations["updateDataRetention"];
        trace?: never;
    };
    "/api-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List API keys
         * @description Lists API key metadata only. Raw key secrets are not returned after creation/rotation. Results include expiry and scope. A restricted API-key caller receives `apiKeys: []`; only an unrestricted account key or browser/CLI session receives the account inventory. Bearer header is unchanged; scope lives on the key.
         */
        get: operations["apiKeys"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api-keys/scoped": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a scoped API key
         * @description Creates a scoped, expiring API key. Requires a dashboard/CLI session or an admin-scoped token. The secret is returned once. This dedicated path returns a typed 503 until scoped credential creation is activated.
         */
        post: operations["createScopedApiKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api-keys/{apiKeyId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                apiKeyId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke an API key
         * @description Revokes the key immediately. Requires a dashboard or CLI session.
         */
        delete: operations["revokeApiKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api-keys/{apiKeyId}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                apiKeyId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate an API key
         * @description Replaces the raw secret without changing expiry or scope. Requires a dashboard or CLI session.
         */
        post: operations["rotateApiKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api-keys/{apiKeyId}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description API key ID returned by `GET /api-keys`. */
                apiKeyId: string;
            };
            cookie?: never;
        };
        /**
         * Get API key usage
         * @description Returns the key's request total for the 30-day UTC window and the sandboxes and Agents it created that still exist, including sandboxes that never got a sandbox row. Works for revoked keys owned by the authenticated account.
         */
        get: operations["apiKeyUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/deletion-operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get deletion operation
         * @description Poll an accepted Boat or snapshot deletion. Only operations owned by the authenticated account are returned. Responses are never cached.
         */
        get: operations["getDeletionOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/environments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Sandbox environments
         * @description Returns every non-deleted sandbox environment with its latest-version flags, contents, and per-version sandbox usage. A default environment named `base` is created on first access if none exists.
         */
        get: operations["environments"];
        put?: never;
        /**
         * Create a sandbox environment
         * @description Create a new named environment. It starts on version 1 with all fine-grained flags on and `safeForThirdParties` off.
         */
        post: operations["createEnvironment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/environments/{environmentId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Environment id returned by `GET /environments`. */
                environmentId: string;
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Update a sandbox environment
         * @description Rename, set as default, and/or edit flags and contents. Any flag or content change mints a new immutable version; existing sandboxes stay on their pinned version until you call upgrade.
         */
        put: operations["updateEnvironment"];
        post?: never;
        /**
         * Delete a sandbox environment
         * @description Soft-deletes an environment. The default environment cannot be deleted, and at least one environment is always kept.
         */
        delete: operations["deleteEnvironment"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/environments/{environmentId}/repos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add a repository to an environment
         * @description Adds a repository (or updates its base branch) by database id from the repository list. Mints a new immutable version.
         */
        post: operations["addEnvironmentRepo"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/environments/{environmentId}/repos/{repositoryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a repository from an environment
         * @description Removes one repository from the environment's selection. Mints a new immutable version.
         */
        delete: operations["deleteEnvironmentRepo"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/environments/{environmentId}/secret-files": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Write one secret file
         * @description Adds or replaces a single secret file by path. Mints a new immutable version.
         */
        put: operations["setEnvironmentSecretFile"];
        post?: never;
        /**
         * Remove one secret file
         * @description Removes the secret file at `path`. Mints a new immutable version.
         */
        delete: operations["deleteEnvironmentSecretFile"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/environments/{environmentId}/upgrade": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upgrade sandboxes to an environment's latest version
         * @description Repoints the caller's active sandboxes from an older version of this environment to its latest version, scrubbing any owner secrets the new version drops and hot-pushing the new config.
         */
        post: operations["upgradeEnvironment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/environments/{environmentId}/vars/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
                /** @description Environment variable name. */
                key: string;
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Set one environment variable
         * @description Sets or replaces a single variable without reading or rewriting the rest. Mints a new immutable version.
         */
        put: operations["setEnvironmentVar"];
        post?: never;
        /**
         * Remove one environment variable
         * @description Removes a single variable. Mints a new immutable version.
         */
        delete: operations["deleteEnvironmentVar"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/limits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Boat limits
         * @description Check remaining machine starts, compute time, credits, access readiness, and concurrent-sandbox capacity for the wallet a create would bill: the `org` / `X-Boat-Org` you pass (id or name), else the account's active wallet, else personal. The response carries `teamId` when an organization wallet was read.
         */
        get: operations["limits"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get current Boat user
         * @description Returns GitHub identity for the authenticated Boat account.
         */
        get: operations["me"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/named-snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List named snapshots
         * @description List your named snapshots, newest first.
         */
        get: operations["listNamedSnapshots"];
        put?: never;
        /**
         * Save a named snapshot
         * @description Freeze a sandbox's current state under a name (`boat snapshot <id> <name>` in the CLI). Answers `202` immediately with the snapshot in `saving`; a running sandbox takes a fresh capture first, which can run minutes. Poll `GET /named-snapshots/{name}` until the status settles at `ready` or `failed`. Reusing one of your existing names replaces that snapshot's artifact once the new save is ready.
         */
        post: operations["saveNamedSnapshot"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/named-snapshots/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a named snapshot */
        get: operations["getNamedSnapshot"];
        put?: never;
        post?: never;
        /**
         * Remove a named snapshot
         * @description Remove a named snapshot and release its storage (`boat snapshot rm <name>` in the CLI). Sandboxes already deployed from it are unaffected.
         */
        delete: operations["deleteNamedSnapshot"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orgs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List organizations
         * @description The wallets this account can bill: your personal account first, then every organization you belong to, each with its id and name. Either spelling works wherever an org is passed (`org`, `X-Boat-Org`, `teamId`). `active` marks the wallet new sandboxes bill when a request names none; change it with `PATCH /orgs/active`.
         */
        get: operations["listOrganizations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orgs/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set the active organization
         * @description Set the wallet new sandboxes bill when a request names none, for this account on every client: the API, the CLI (`boat org switch` sets the same value) and the dashboard. Pass an organization id or name you belong to, or `personal` (or `null`) for your own account. `GET /limits` follows it. Sandboxes already running keep the wallet they were created with; leaving or deleting the organization resets the account to personal.
         */
        patch: operations["setActiveOrganization"];
        trace?: never;
    };
    "/repos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List GitHub repositories available to Boat
         * @description Returns GitHub repositories grouped by installation plus the current selected repositories for new Sandboxes.
         */
        get: operations["repos"];
        put?: never;
        /**
         * Select repository for sandboxes
         * @description Idempotently selects one repository for the sandbox environment. Use `databaseId` from `GET /repos` as `repositoryId`; selecting an already-selected repository updates its `baseBranch`.
         */
        post: operations["selectRepo"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List sandboxes */
        get: operations["sandboxes"];
        put?: never;
        /**
         * Create sandbox
         * @description Provision a new cloud computer. Store the returned `sandbox.id` with your product job/session record. Send an `Idempotency-Key` header to make this call safe to retry after a lost response without creating a second billable sandbox.
         */
        post: operations["create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        /**
         * Get sandbox
         * @description Poll this endpoint after create, stop, resume, or fork operations.
         */
        get: operations["get"];
        put?: never;
        post?: never;
        /**
         * Permanently delete sandbox data
         * @description Accept irreversible background deletion of the sandbox machine, snapshots, and content-bearing records. This is not archive: the sandbox cannot be resumed. Named snapshots and other shared artifacts remain independent. Poll the returned operation until `completed`.
         */
        delete: operations["deleteSandbox"];
        options?: never;
        head?: never;
        /** Update sandbox */
        patch: operations["update"];
        trace?: never;
    };
    "/sandboxes/{sandboxId}/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Download a sandbox artifact */
        get: operations["artifact"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Execute a command in a sandbox
         * @description Runs the command synchronously by default (timeout configurable via `timeoutSeconds`, 600s cap). With `detached: true` the command starts in the background and a process id is returned immediately; poll `/sandboxes/{sandboxId}/commands/{processId}` for status and logs. Returns 400 invalid_timeout when `timeoutSeconds` is not an integer in 1-600. Returns 409 boat_starting (retryable) while the sandbox is still provisioning -- wait until the sandbox state is ready before running commands. Command execution is never retried automatically: a 502 boat_direct_failed means the command may already be running on the sandbox.
         */
        post: operations["command"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/commands/{processId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get detached command status and logs */
        get: operations["commandStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List boat conversations
         * @description Every conversation on the sandbox, most recently prompted first, with what you need to pick one: how many prompts it holds, whether a turn is running in it right now, the last harness and model it ran on, a preview of its last prompt, and `current`, the one a `POST /prompt` without `new` or `conversationId` would continue. Pass an `id` back as `conversationId` on `POST /prompt` to resume that thread, or as `conversation` on `POST /steer`, `POST /interrupt` and `GET /events` to scope those. See [Integrated agents](/integrated-agents).
         */
        get: operations["conversations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/desktop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get desktop streaming URL
         * @description Create or fetch a secret-bearing desktop/noVNC URL for live computer-use visibility. Use `?vnc=1` for noVNC; a `provisioning: true` response means poll again.
         */
        post: operations["desktop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List boat events
         * @description Return Sandbox work, lifecycle, and progress events so product UIs can show what the sandbox is doing. A Sandbox runs many conversations in parallel; this streams **all** of them by default and every event carries a `conversationId`. Filter to one or more with `conversation`. Event payloads are extensible. Clients can long-poll this endpoint with `sort=asc` and a cursor to stream responses. Response events expose agent text, streaming partials via `data.is_streaming`, and tool calls/results via `data.tools`.
         */
        get: operations["events"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a file from a sandbox */
        get: operations["readFile"];
        /** Write a file in a sandbox */
        put: operations["writeFile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/fork": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fork sandbox
         * @description Provision a new sandbox from an existing one. Send an `Idempotency-Key` header to make this call safe to retry after a lost response without creating a second billable fork.
         */
        post: operations["fork"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/host": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Expose a sandbox port on a public HTTPS URL
         * @description Registers a stable `https://<sandbox-subdomain>-<port>.on.boat.dev` route for a port inside the sandbox and opens the sandbox firewall for it. Idempotent: calling it again for the same sandbox and port returns the same URL and token.
         */
        post: operations["hostPort"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/interrupt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Interrupt running work
         * @description Interrupt running agent work. By default this stops **every** conversation on the sandbox. Pass `conversation` to stop just one, leaving the others running. See [Integrated agents](/integrated-agents).
         */
        post: operations["interrupt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/prompt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Prompt Sandbox
         * @description Queue a natural-language work item for an agent harness (Codex, Claude Code, pi, OpenCode, or Prime Agent) inside the sandbox. Observe progress with `GET /sandboxes/{sandboxId}/events`.
         *
         *     A Sandbox runs many conversations in parallel. Set `new: true` to start a fresh one, `conversationId` to continue a specific one, or omit both to continue the most-recently-active conversation; the response returns the `conversationId`. See [Integrated agents](/integrated-agents).
         */
        post: operations["prompt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/prompts/{promptId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get prompt run status
         * @description Returns first-class status for a queued/running/finished prompt so clients do not infer completion from sandbox state and events.
         */
        get: operations["promptRunStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume sandbox */
        post: operations["resume"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List boat snapshots
         * @description List visible completed snapshots for one sandbox with uncapped cursor pagination.
         */
        get: operations["listSandboxSnapshots"];
        put?: never;
        post?: never;
        /**
         * Permanently delete all snapshots of a sandbox
         * @description Accept irreversible deletion of every unpinned snapshot of this sandbox. The sandbox itself and its named snapshots stay. Snapshots disappear from lists, restores and forks immediately; their stored data is purged in the background. Set `X-Ascii-Confirm-Delete` to the sandbox id.
         */
        delete: operations["deleteSandboxSnapshots"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/snapshots/latest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get latest boat snapshot
         * @description Return the most recent completed snapshot for this sandbox, or `null` if it has none.
         */
        get: operations["getLatestSandboxSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/sshkey": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Configure sandbox SSH key
         * @description Adds an OpenSSH public key to the running sandbox so the caller can SSH as user `user`. The response carries `machineIp`, which is the host to connect to on port 22.
         *
         *     This is also how you reach your own machine from inside a sandbox without the CLI: authorize the key, then open a reverse tunnel with stock OpenSSH, and a port on your machine answers at `127.0.0.1:<port>` inside the sandbox for as long as the ssh process runs.
         *
         *     ```bash
         *     ssh -o ExitOnForwardFailure=yes -i ~/.ssh/id_ed25519 -N -R 7777:127.0.0.1:7777 user@<machineIp>
         *     ```
         *
         *     `boat forward <id> --reverse --local 7777` is the same tunnel with the key handling and redial done for you.
         */
        post: operations["sshKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/steer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Steer a running turn
         * @description Send a new message to a turn that is already running, without losing what the agent is doing. This is what typing into a coding agent while it works does: the instruction is taken into account and the work continues.
         *
         *     Where the harness has a native mid-turn primitive (Claude Code, Codex, pi, Prime Agent) nothing is interrupted and the response has `native: true`. Where it does not (OpenCode), Boat interrupts that turn and immediately continues the SAME conversation with the instruction, keeping the session and its memory, and the response has `native: false`.
         *
         *     Refused with **409 `no_running_turn`** when the conversation has nothing in flight; queue work with `POST /prompt` instead. The steer shows up in `GET /events` as a `steer` event. See [Integrated agents](/integrated-agents).
         */
        post: operations["steer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop and archive sandbox
         * @description Stop active work and archive/snapshot the sandbox for later resume or fork.
         *
         *     A stop always saves the sandbox's disk first. If that save is failing, the stop is
         *     refused and the sandbox keeps running so your work is not discarded, we retry
         *     automatically and email you. You are not billed for time spent in that state.
         *
         *     Set `force: true` to stop anyway, accepting the loss of everything written since
         *     the last successful snapshot. This is irreversible; only reach for it after a
         *     stop has already failed.
         */
        post: operations["stop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandboxes/{sandboxId}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get boat usage
         * @description Machine time one sandbox consumed, and what it costs, so you can bill your own users per sandbox. Same meter as `GET /limits`: billable seconds with the sandbox type's multiplier applied, paused past a refused stop, never counting time stopped. Narrow it to a billing period with `since` and `until`; a period boundary that falls inside a running stretch splits that stretch pro rata. Works while the sandbox runs and after it stops.
         */
        get: operations["usage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Boat secrets setup
         * @description Returns the environment variables and secret files configured for sandboxes.
         */
        get: operations["secrets"];
        put?: never;
        /** Update Boat secrets setup */
        post: operations["updateSecrets"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List snapshots
         * @description List visible completed snapshots across all of your sandboxes using immutable ownership attribution. Pinned, deletion-scheduled, and privacy-fenced sandbox snapshots are omitted. Follow `nextCursor` through the complete history; there is no hidden 500-snapshot cap.
         */
        get: operations["listSnapshots"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/snapshots/{snapshotId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Permanently delete snapshot data
         * @description Accept irreversible deletion of an unpinned snapshot owned by the authenticated account. Any such snapshot is accepted: it disappears from lists, restores and forks immediately, and its stored data is purged in the background once nothing still reads it (see the operation's `stage`). `409` only means `X-Ascii-Confirm-Delete` is missing or wrong.
         */
        delete: operations["deleteSnapshot"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/snapshots/{snapshotId}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get snapshot download
         * @description Return time-limited signed URLs for every chunk needed to reconstruct the sandbox filesystem at this snapshot (the full chain, base through this generation), plus the inventory. Download the chunks and reassemble them as described by `reconstruct`. The `boat snapshot pull` CLI command does this for you.
         */
        get: operations["getSnapshotDownload"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/snapshots/{snapshotId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download a file or folder from a snapshot
         * @description Stream a single file's bytes, or a folder subtree as a tar archive, directly out of a snapshot, the sandbox can be stopped or archived; the machine is never contacted. Use `GET /snapshots/{snapshotId}/tree` to list paths, then pass one here. Paths are relative to the snapshot root (same space as `tree` entries; docker volumes under `__dockervol__/`). An empty or `/` path downloads the whole snapshot as a tar. Folder responses set `X-Snapshot-File-Count`, `X-Snapshot-Total-Size-Bytes` and `X-Snapshot-Skipped-Base-Image-Files` headers; both response shapes set `X-Snapshot-Entry-Kind` (`file` or `dir`).
         */
        get: operations["getSnapshotFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/snapshots/{snapshotId}/tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get snapshot file tree
         * @description List the files and folders captured in a snapshot, with sizes. Returns a flat list of entries you can render as a tree.
         */
        get: operations["getSnapshotTree"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List webhooks
         * @description Lists account-wide sandbox lifecycle webhook endpoints. Signing secrets are never included.
         */
        get: operations["listWebhooks"];
        put?: never;
        /**
         * Create webhook
         * @description Registers an account-wide endpoint for sandbox lifecycle events. The endpoint must use HTTPS on port 443 and resolve only to public addresses. Redirects are not followed during delivery.
         *
         *     The signing secret is returned only in this response. An account can register at most 10 unique endpoint URLs.
         */
        post: operations["createWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/webhooks/{webhookId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        /**
         * Get webhook
         * @description Returns webhook metadata without the signing secret.
         */
        get: operations["getWebhook"];
        put?: never;
        post?: never;
        /**
         * Delete webhook
         * @description Deletes the endpoint and its queued deliveries. An attempt already in flight can still arrive.
         */
        delete: operations["deleteWebhook"];
        options?: never;
        head?: never;
        /**
         * Update webhook
         * @description Updates the name, endpoint URL, or subscribed events without changing the signing secret.
         */
        patch: operations["updateWebhook"];
        trace?: never;
    };
    "/webhooks/{webhookId}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate webhook signing secret
         * @description Replaces the endpoint's signing secret. The new secret is returned only in this response; briefly accept the old secret for attempts already in flight.
         */
        post: operations["rotateWebhookSigningSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface webhooks {
    sandboxLifecycle: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sandbox lifecycle event delivery
         * @description At-least-once delivery to each subscribed endpoint. Separate events may arrive out of order. Return any 2xx status within 5 seconds to acknowledge the event.
         */
        post: operations["deliverSandboxLifecycleEvent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface components {
    schemas: {
        ActiveOrgResponse: components["schemas"]["SuccessBase"] & {
            active: {
                id: string;
                name: string;
                /** @enum {string} */
                type: "personal" | "org";
            };
            /** @constant */
            type?: "org.active_updated";
        };
        ActiveOrgUpdateRequest: {
            /** @description Organization id or name you belong to; `personal`, your own id or `null` for personal. */
            org: string | null;
        };
        ApiKey: {
            /** Format: date-time */
            createdAt: string;
            /**
             * @description Credential storage lane. Scoped secrets are never stored in the legacy hash column.
             * @enum {string}
             */
            credentialLane: "legacy" | "scoped-v1";
            expired?: boolean;
            /** Format: date-time */
            expiresAt?: string | null;
            expiringSoon?: boolean;
            /** @example sak_123 */
            id: string;
            /** @example 9abc */
            keyLastFour: string;
            /** @example boat_live */
            keyPrefix: string;
            /** Format: date-time */
            lastUsedAt: string | null;
            /** @example Production worker */
            name: string;
            resources: components["schemas"]["ApiKeyResourceTotals"];
            /** @description Sandbox ID for a platform-managed machine key, or null for a user-created key. */
            sandboxId: string | null;
            scope?: {
                actions?: string[];
                environments?: "*" | string[];
                /** Format: date-time */
                expiresAt?: string | null;
                grandfathered?: boolean;
                sandboxes?: "*" | string[];
            };
            usage: components["schemas"]["ApiKeyRequestUsage"];
        };
        ApiKeyCatalog: {
            actions: string[];
            /** @example 90d */
            defaultTtl: string;
            /** @example 365d */
            maxTtl: string;
            presets: {
                [key: string]: string[];
            };
            /** @description Session-only selector resources. Omitted when the caller authenticates with an API key. */
            scopeResources?: {
                environments: components["schemas"]["ApiKeyScopeResource"][];
                sandboxes: components["schemas"]["ApiKeyScopeResource"][];
            };
            /** @description Whether POST /api-keys/scoped currently accepts creation requests. */
            scopedCreationEnabled: boolean;
        };
        ApiKeyCreatedResource: {
            /** Format: date-time */
            createdAt: string | null;
            id: string;
            /** @enum {string} */
            kind: "sandbox" | "agent";
            name: string;
            state: string;
        };
        ApiKeyRequestUsage: {
            /**
             * @description Requests authenticated with this key during the current UTC day and the previous 29 UTC days.
             * @example 1842
             */
            requests: number;
            /** @constant */
            windowDays: 30;
        };
        ApiKeyResourceTotals: {
            agents: number;
            sandboxes: number;
            total: number;
        };
        ApiKeyRevokeResponse: components["schemas"]["SuccessBase"] & {
            apiKeys: components["schemas"]["ApiKey"][];
        };
        ApiKeyScopeResource: {
            id: string;
            name: string;
            organizationId: string;
            organizationName: string;
        };
        ApiKeySecretResponse: components["schemas"]["SuccessBase"] & {
            apiKey: components["schemas"]["ApiKey"];
            apiKeys: components["schemas"]["ApiKey"][];
            /** @description Raw secret returned once. Store it before closing the response. */
            secret: string;
        };
        ApiKeyUsageResponse: components["schemas"]["SuccessBase"] & components["schemas"]["ApiKey"] & {
            createdResources: components["schemas"]["ApiKeyCreatedResource"][];
        };
        ApiKeysResponse: components["schemas"]["SuccessBase"] & {
            apiKeys: components["schemas"]["ApiKey"][];
            catalog: components["schemas"]["ApiKeyCatalog"];
        };
        CommandRequest: {
            command: string;
            /** @description Relative working directory inside the sandbox work directory. */
            cwd?: string;
            /**
             * @description Start the command in the background and return a process id immediately instead of waiting for it to finish. Output goes to a log file on the sandbox; poll the status endpoint for it.
             * @default false
             */
            detached?: boolean;
            /**
             * @description Command timeout in seconds. Values outside 1-600 are rejected with a 400 invalid_timeout error.
             * @default 30
             */
            timeoutSeconds?: number;
        };
        CommandResponse: components["schemas"]["SuccessBase"] & {
            cwd?: string;
            exitCode: number | null;
            /** Format: date-time */
            finishedAt?: string;
            /** @description True when the memory ceiling killed the command or one of its processes and the command failed. */
            oomKilled?: boolean;
            signal?: string | null;
            /** Format: date-time */
            startedAt?: string;
            stderr: string;
            stderrTruncated?: boolean;
            stdout: string;
            stdoutTruncated?: boolean;
            success: boolean;
            timedOut: boolean;
            /** @constant */
            type?: "command.finished";
        };
        CommandStartedResponse: components["schemas"]["SuccessBase"] & {
            command: string;
            cwd?: string;
            /** @description Stderr log file on the sandbox. */
            errLogPath?: string;
            /** @description Stdout log file on the sandbox (~/.ascii/processes/<pid>.log). */
            logPath?: string;
            pid: number;
            /** @description Process id to poll with the command status endpoint. */
            processId: number;
            /** Format: date-time */
            startedAt: string;
            success: boolean;
            /** @constant */
            type?: "command.started";
        };
        CommandStatusResponse: components["schemas"]["SuccessBase"] & {
            command?: string | null;
            cwd?: string | null;
            errLogPath?: string;
            exitCode: number | null;
            /** Format: date-time */
            finishedAt?: string | null;
            /** @description Whether the process is still tracked by the sandbox agent. */
            known?: boolean;
            logPath?: string;
            /** @description True when the memory ceiling killed the command or one of its processes and the command failed. */
            oomKilled?: boolean;
            pid?: number;
            processId: number;
            running: boolean;
            signal?: string | null;
            /** Format: date-time */
            startedAt?: string | null;
            /**
             * @description lost: the sandbox agent restarted and forgot the process; running/exitCode are then a best-effort probe and the logs come from the on-disk files.
             * @enum {string}
             */
            status: "running" | "exited" | "lost";
            /** @description Tail of the stderr log file. */
            stderr: string;
            stderrTruncated?: boolean;
            /** @description Tail of the stdout log file. */
            stdout: string;
            stdoutTruncated?: boolean;
            success: boolean;
            /** @constant */
            type?: "command.status";
        };
        CompletionEvent: {
            data: {
                [key: string]: unknown;
            };
            id: string;
            taskId?: string | null;
            timestamp: number;
            /** @constant */
            type: "compaction_complete";
        };
        Conversation: {
            /**
             * Format: date-time
             * @description When the first prompt of this conversation was queued.
             */
            createdAt: string | null;
            /** @description `true` on the conversation a `POST /prompt` without `new` or `conversationId` would continue: the sandbox's most recently prompted one. Exactly one conversation is current unless the list is empty. */
            current: boolean;
            /** @description Conversation id. Pass it as `conversationId` on `POST /prompt` to continue this thread. */
            id: string;
            /** @description Harness the most recent prompt ran on (`claude`, `codex`, `pi`, `opencode`, `prime-agent`, `kimi`). */
            lastHarness: string | null;
            /** @description Model id of the most recent prompt that chose one, or `null` when every prompt used the harness default. */
            lastModel: string | null;
            /**
             * Format: date-time
             * @description When its most recent prompt was queued. The list is sorted by this, newest first.
             */
            lastPromptAt: string | null;
            /** @description The first 80 characters of the most recent prompt. */
            lastPromptPreview: string | null;
            /** @description Number of prompts sent to this conversation. */
            prompts: number;
            /** @description `true` while a turn is queued or running in this conversation. */
            running: boolean;
        };
        ConversationsResponse: components["schemas"]["SuccessBase"] & {
            conversations: components["schemas"]["Conversation"][];
            /** @description Sandbox id. */
            id: string;
            /** @constant */
            type?: "conversation.list";
        };
        CreateSandboxEnvironmentRequest: {
            /**
             * @description Unique environment name. Letters, numbers, dot, dash, underscore; max 64 chars.
             * @example customer-demos
             */
            name: string;
        };
        /**
         * @description Options for provisioning a new cloud computer.
         * @example {
         *       "ttlSeconds": 3600
         *     }
         * @example {
         *       "ttlSeconds": null
         *     }
         * @example {
         *       "ttlSeconds": 3600,
         *       "type": "large"
         *     }
         * @example {
         *       "env": {
         *         "DATABASE_URL": "postgres://user:pass@host:5432/app",
         *         "FEATURE_FLAG": "1"
         *       },
         *       "ttlSeconds": 3600
         *     }
         * @example {
         *       "noEnv": true,
         *       "ttlSeconds": null
         *     }
         */
        CreateSandboxRequest: {
            /** @description Per-sandbox environment variables injected into the sandbox's tool environment, on top of the account environment's variables (per-sandbox values win on conflicts). Keys must match `[A-Za-z_][A-Za-z0-9_]{0,127}`; at most 100 variables and 64KB total. Reserved names (`ASCII_TOKEN`, `ASCII_API_URL`, `AGENT_ID`, `PRODUCT_MODE`, `ENVIRONMENT_ID`, `BOAT_ID`, `SERVICE_PREVIEW_TOKEN`, `BOAT_CLI_TOKEN`) are rejected with `invalid_env`. Forked sandboxes inherit the source sandbox's env unless the fork request supplies its own `env`. */
            env?: {
                [key: string]: string;
            };
            /**
             * @description Name of the sandbox environment to attach to this sandbox. Environments are managed in the Boat dashboard and bundle the repositories, secrets, and credential toggles a sandbox gets. Omit to use your default environment (`base` unless you changed it). Unknown names are rejected with `unknown_environment`. An environment marked "safe for third parties" passes nothing to the sandbox, exactly like `noEnv`.
             * @default base
             * @example base
             * @example customer-demos
             */
            environment?: string;
            /** @description Create the sandbox from a named snapshot (saved with `POST /named-snapshots`, or `boat snapshot <id> <name>` in the CLI). The sandbox starts from that exact frozen state. Omitting `type` inherits the type the snapshot was saved from; env and no-env inherit from the snapshot's source sandbox unless the request passes its own, with the same rules as forking. */
            from?: string;
            /**
             * @description Create a sandbox with none of the secrets attached to your account (no environment variables, secret files, or credentials), confined to itself so it cannot act on your account or other sandboxes. For sandboxes you give to your own users. SSH, SCP, desktop, snapshots, and public URLs still work; pass `env` to give the sandbox a secret of its own. A fork of a no-env sandbox is always no-env. Equivalent to attaching an environment marked "safe for third parties".
             * @default false
             */
            noEnv?: boolean;
            /** @description Bill this sandbox to an organization you belong to (its shared wallet), by id or by name as `GET /orgs` lists it; `personal` or your own account id means personal billing. Omitted, the `X-Boat-Org` / `?org=` request scope applies, then the account's active wallet (`PATCH /orgs/active`), then personal. Listing, snapshots, and environments stay yours: the org is a wallet, not a shared workspace. Takes precedence over `teamId`. */
            org?: string;
            /** @description Shell script that runs on the sandbox after it is ready. Ready means "ready to accept the user", not "setup done": the script starts in the background once provisioning completes and never blocks the sandbox becoming usable. It runs as the sandbox user via `bash`, with the sandbox's environment applied, and its output goes to a log file on the sandbox. Observe the outcome as `setupStatus` (pending/running/done/failed) and `setupError` on the sandbox. Rejected with a 400 `invalid_setup_script` error when it is not a string or exceeds 64KB. */
            setupScript?: string;
            /** @description Legacy alias for `org`. Ignored when `org` is also set. */
            teamId?: string;
            /**
             * @description Number of seconds before automatic archival. `null` disables auto-stop. The backend also accepts the string `infinite` for legacy compatibility; new clients should send null.
             * @default 3600
             */
            ttlSeconds?: number | null;
            /**
             * @description Machine size. `small` consumes machine time at half rate and `large` at twice the default rate (see the Billing guide). A fork inherits the source sandbox's type unless the fork request passes its own, and resume and fork can move a sandbox between sizes.
             * @default default
             * @enum {string}
             */
            type?: "small" | "default" | "large";
        };
        CreateSandboxResponse: components["schemas"]["SuccessBase"] & {
            /** @description Present when a fair-use cap on a gifted account shortened the requested auto-stop time. */
            giftLimitNotice?: string;
            sandbox: components["schemas"]["Sandbox"];
            /**
             * @description `ready` only when an idempotent retry finds a sandbox that is already past provisioning.
             * @enum {string}
             */
            status: "provisioning" | "ready";
            ttlSeconds: number | null;
            /** @constant */
            type?: "sandbox.created";
        };
        DataRetentionPolicyResponse: components["schemas"]["SuccessBase"] & {
            /** @description Always true on updates. Disabling the policy does not cancel accepted deletion operations. */
            acceptedDeletionOperationsIrreversible?: boolean;
            enabled: boolean;
            /** Format: date-time */
            enabledAt: string | null;
            /** @description Archived Sandboxes newly queued for deletion by this policy update. */
            queuedSandboxes?: number;
            /** @enum {string} */
            type?: "data_retention.info" | "data_retention.updated";
        };
        DataRetentionUpdateRequest: {
            /**
             * @description Required when enabling and must exactly equal `delete archived sandbox data`.
             * @constant
             */
            confirmation?: "delete archived sandbox data";
            enabled: boolean;
        };
        DeletionOperation: {
            attemptCount: number;
            /** Format: date-time */
            completedAt: string | null;
            /**
             * Format: date-time
             * @description When `waiting_for_uploads` ends.
             */
            expectedBy?: string | null;
            id: string;
            /** @enum {string} */
            kind: "sandbox" | "snapshot";
            /** @enum {string} */
            reason: "explicit" | "zdr" | "account";
            /** Format: date-time */
            requestedAt: string;
            /**
             * @description What the background purge is doing. The target is already gone from every list, restore and fork once the operation exists. `waiting_for_uploads`: stored data is erased once the last upload URL issued for it expires (`expectedBy`). `kept_for_newer_snapshots`: a newer snapshot you kept is built on this one; its data goes when they go. `waiting_for_restore`: a sandbox is still restoring from it. `retrying`: a transient fault, retried automatically.
             * @enum {string}
             */
            stage?: "removing" | "waiting_for_uploads" | "kept_for_newer_snapshots" | "waiting_for_restore" | "retrying" | "completed";
            /** @enum {string} */
            status: "pending" | "processing" | "blocked" | "completed";
            targetId: string;
        };
        DeletionOperationListResponse: components["schemas"]["SuccessBase"] & {
            operations: components["schemas"]["DeletionOperation"][];
            /** @enum {string} */
            type?: "snapshot.deleting";
        };
        DeletionOperationResponse: components["schemas"]["SuccessBase"] & {
            operation: components["schemas"]["DeletionOperation"];
            /** @enum {string} */
            type?: "deletion.operation" | "sandbox.deleting" | "snapshot.deleting";
        };
        /** @description Optional desktop/VNC setup options used by the Boat dashboard and CLI. Most callers send an empty body. */
        DesktopRequest: {
            /**
             * @description For `?vnc=1`, return a noVNC URL that does not require an access token.
             * @default false
             */
            publicAccess?: boolean;
        } & {
            [key: string]: unknown;
        };
        DesktopResponse: components["schemas"]["SuccessBase"] & ({
            /**
             * Format: uri
             * @description Secret-bearing desktop or noVNC URL. Redact from logs.
             */
            desktopUrl?: string | null;
            ip?: string | null;
            message?: string;
            /** @example vnc */
            mode?: string;
            /** @description For `?vnc=1`, true means VNC is still being prepared; poll again. */
            provisioning?: boolean;
            success?: boolean;
            /** @example desktop.url */
            type?: string;
        } & {
            [key: string]: unknown;
        });
        /** @description Result of a granular environment change. Every change mints a new immutable version holding just that delta; existing sandboxes stay pinned until upgraded. */
        EnvironmentItemChangeResponse: {
            success: boolean;
            /** @description Id of the newly minted environment version. This is a version id, not the environment's own id: the environment id you passed in the path is unchanged. */
            versionId?: string;
            versionNumber?: number;
        };
        ErrorEnvelope: {
            /** @example provider_not_configured */
            code: string;
            error: {
                code: string;
                details?: {
                    [key: string]: unknown;
                };
                message: string;
                status: number;
            };
            /** @example Prompting is locked until Codex is configured on the Agents page. */
            message: string;
            /** @example false */
            ok: boolean;
            /** @example req_01HX... */
            requestId: string;
            /** @example 409 */
            status: number;
            /** @example sandbox.error */
            type: string;
        };
        ErrorEvent: {
            data: {
                [key: string]: unknown;
            };
            id: string;
            taskId?: string | null;
            timestamp: number;
            /** @constant */
            type: "usage_limit";
        };
        EventsResponse: components["schemas"]["SuccessBase"] & {
            /** @description Sandbox work and lifecycle event objects. Event shapes are intentionally extensible; branch on each event `type` when present. */
            events: components["schemas"]["SandboxEvent"][];
            id: string;
            pageInfo?: components["schemas"]["PageInfo"];
            /** @constant */
            type?: "events.list";
        };
        FileReadResponse: components["schemas"]["SuccessBase"] & {
            content: string;
            /** @enum {string} */
            encoding: "utf8" | "base64";
            path: string;
            size: number;
            success: boolean;
            /** @constant */
            type?: "file.read";
        };
        FileWriteRequest: {
            content: string;
            /**
             * @default utf8
             * @enum {string}
             */
            encoding?: "utf8" | "base64";
            /** @description Absolute path, or path relative to the sandbox work directory (/home/user). The canonicalized path must resolve under /home/user or /tmp; anything else is rejected with a 400 invalid_path error. */
            path: string;
        };
        FileWriteResponse: components["schemas"]["SuccessBase"] & {
            /** @enum {string} */
            encoding: "utf8" | "base64";
            path: string;
            size: number;
            success: boolean;
            /** @constant */
            type?: "file.written";
        };
        HostPortRequest: {
            /** @description Port the service listens on inside the sandbox. */
            port: number;
            /**
             * @description Return an ungated URL instead of one that requires the `_token` query parameter.
             * @default false
             */
            public?: boolean;
            /** @description Display title for the hosted port. */
            title?: string;
        };
        HostPortResponse: components["schemas"]["SuccessBase"] & ({
            /** @enum {string} */
            access?: "private" | "public";
            isProtected?: boolean;
            port?: number;
            success?: boolean;
            /** @example port.hosted */
            type?: string;
            /**
             * Format: uri
             * @description Public HTTPS URL. Carries the `_token` query parameter unless the port is public; redact from logs.
             */
            url?: string;
        } & {
            [key: string]: unknown;
        });
        LimitsFields: {
            /** @example trial */
            accessTier?: string;
            /**
             * @example user
             * @example service
             */
            accountPlan?: string;
            activeSandboxes: number;
            activeStates?: string[];
            /** @description Account access state returned by the current backend. Billing endpoints are not part of v1. */
            billingStatus: string;
            blockedReason?: string | null;
            /** @description Whether the authenticated account can create or operate sandboxes right now. */
            canStart: boolean;
            checkoutRequired?: boolean;
            contactMessage?: string | null;
            /** @description Remaining machine time in hours (`creditBalanceSeconds / 3600`). Null on unlimited accounts. */
            creditBalanceHours?: number | null;
            creditBalanceSeconds?: number;
            creditPurchasedSeconds?: number;
            creditSecondsPerDollar?: number;
            creditUsedSeconds?: number;
            currentLimits?: {
                activeSandboxes?: number;
                creationRatePerMinute?: number;
                creationRequestsPerDay?: number | null;
                creationRequestsPerHour?: number | null;
            } & {
                [key: string]: unknown;
            };
            /** @description Fair-use caps on a gifted account, or null when there are none. */
            giftLimit?: {
                /** @description The caps in one readable line. */
                line?: string | null;
                maxActiveSandboxes?: number | null;
                maxTtlSeconds?: number | null;
                /** @description The same text shown when a cap is hit. */
                message?: string;
            } | null;
            hasPaymentHistory?: boolean;
            /** @description True when an organization has an active per-seat plan. */
            hasSeatPlan?: boolean;
            hasSubscription?: boolean;
            /** @description Machine time used in the last 24 hours, in seconds. Useful to estimate how long the balance lasts. */
            last24hUsageSeconds?: number;
            liveUsageSeconds?: number;
            maxActiveSandboxes: number;
            maxCreationRequestsPerDay?: number | null;
            maxCreationRequestsPerMinute?: number;
            /** @description Remaining purchased credit packs in dollars. */
            packBalanceDollars?: number;
            /** @description Remaining purchased credit packs in hours. */
            packBalanceHours?: number;
            packBalanceSeconds?: number;
            package?: {
                [key: string]: unknown;
            };
            /** @description `service` for service accounts, otherwise null. */
            plan?: string | null;
            /** @description `Service` for service accounts, otherwise null. */
            planName?: string | null;
            /** @description Monthly price of the current plan in dollars. */
            sandboxPlanDollars?: number;
            /**
             * @description Current plan key, or `trial` before any payment.
             * @example box_20
             */
            sandboxPlanKey?: string;
            /** @description Every plan tier and its limits. */
            sandboxPlanTiers?: {
                /** @example $20/mo */
                displayPrice?: string;
                dollars?: number;
                /** @description Machine time included each month. */
                includedSeconds?: number;
                /** @example box_20 */
                key?: string;
                maxActiveSandboxes?: number;
                /** @description Whether this tier can be bought right now. */
                purchasable?: boolean;
                startsPerDay?: number;
                startsPerHour?: number;
                startsPerMinute?: number;
            }[];
            serviceAccount?: boolean;
            standardLimits?: {
                activeSandboxes?: number;
                creationRatePerMinute?: number;
                creationRequestsPerDay?: number | null;
                creationRequestsPerHour?: number | null;
            } & {
                [key: string]: unknown;
            };
            startBlockedReason?: string | null;
            /** @description Plan caps for machine starts. Null on unlimited accounts. Create, fork and resume each count as one start. */
            startLimits?: {
                perDay?: number;
                perHour?: number;
                perMinute?: number;
            } | null;
            /** @description Remaining machine starts in the rolling minute, hour and day windows. Null windows mean the account is unlimited. */
            starts?: {
                day?: components["schemas"]["StartWindowUsage"];
                hour?: components["schemas"]["StartWindowUsage"];
                minute?: components["schemas"]["StartWindowUsage"];
                unlimited?: boolean;
            };
            subscriptionCancelAtPeriodEnd?: boolean;
            /** Format: date-time */
            subscriptionCurrentPeriodEnd?: string | null;
            subscriptionQuotaSeconds?: number;
            subscriptionRemainingSeconds?: number;
            subscriptionStatus?: string | null;
            /** Format: date-time */
            subscriptionTrialEndsAt?: string | null;
            /** @description Present when limits were read for a team wallet (`?teamId=`, `?org=`, or `X-Boat-Org`). */
            teamId?: string;
            /** @description Caller's role on that team when `teamId` is present. */
            teamRole?: string;
            /** @description Lifetime machine-time allowance for a trial that never paid. Null once the account has paid or has a plan. */
            trialComputeCapSeconds?: number | null;
            trialLimits?: {
                activeSandboxes?: number;
                creationRatePerMinute?: number;
                creationRequestsPerDay?: number | null;
                creationRequestsPerHour?: number | null;
            } & {
                [key: string]: unknown;
            };
            /** @description The trial limits in one readable line. Null on paid accounts. */
            trialLine?: string | null;
            /** @description True when the account has no machine-time or start limits. */
            unlimited?: boolean;
            upgradeEffects?: {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
        };
        LimitsResponse: components["schemas"]["SuccessBase"] & components["schemas"]["LimitsFields"];
        MeResponse: components["schemas"]["SuccessBase"] & {
            /** @constant */
            type?: "user.info";
            user: {
                /**
                 * @example user
                 * @example service
                 */
                accountPlan?: string;
                /** @enum {string} */
                accountStatus?: "active" | "suspended" | "closed";
                closed?: boolean;
                /** Format: date-time */
                closedAt?: string | null;
                /** @description Address to contact about a suspended or closed account. */
                closureContactEmail?: string;
                /**
                 * @description The login method the account was created with.
                 * @enum {string}
                 */
                connectionMethod?: "github" | "google" | "email" | "service";
                /** @description Every login method linked to the account. */
                connectionMethods?: string[];
                displayName?: string;
                email?: string | null;
                /** @description Your account id. */
                id?: string;
                login?: string;
                /**
                 * Format: date-time
                 * @description When a closed account's data is scheduled for deletion.
                 */
                purgeAt?: string | null;
                /**
                 * Format: date-time
                 * @description When a closed account's data was deleted.
                 */
                purgedAt?: string | null;
                serviceAccount?: boolean;
                suspended?: boolean;
                /** Format: date-time */
                suspendedAt?: string | null;
                suspendedReason?: string | null;
                /** @description Whether archived sandbox data is configured for deletion instead of retention. */
                zeroDataRetention?: boolean;
                /** Format: date-time */
                zeroDataRetentionEnabledAt?: string | null;
            };
        };
        /** @description A named snapshot: a frozen copy of a sandbox's disk at one moment, saved under a name you pick. Independent of the source sandbox's later life: the sandbox can change, stop, or be deleted and the named snapshot still deploys. Named snapshots never expire; re-saving a name replaces its artifact. */
        NamedSnapshot: {
            /** Format: date-time */
            createdAt: string;
            /** @description Failure reason. Only present when `status` is `failed`. */
            error?: string;
            /** @description The user-chosen handle, unique within your account. */
            name: string;
            /** @description Restored content size of the frozen state, in bytes. */
            sizeBytes?: number;
            /** @description The frozen artifact behind the name. Present once `status` is `ready`. Accepted by `GET /api/boat/snapshots/{snapshotId}/tree` to browse its files. */
            snapshotId?: string;
            /** @description The sandbox this snapshot was saved from (display only). */
            sourceSandboxId: string;
            /**
             * @description `saving` while the capture and pin are in flight (a live source sandbox takes a fresh snapshot first, which can run minutes), `ready` when deployable, `failed` if the save did not complete (see `error`; save again to retry).
             * @enum {string}
             */
            status: "saving" | "ready" | "failed";
            /** @description Sandbox type the snapshot was saved from. Deploys default to it. */
            type?: string;
        };
        NamedSnapshotDeletedResponse: components["schemas"]["SuccessBase"] & {
            name: string;
            /** @constant */
            status: "deleted";
            /** @constant */
            type?: "snapshot.named.deleted";
        };
        NamedSnapshotInfoResponse: components["schemas"]["SuccessBase"] & {
            snapshot: components["schemas"]["NamedSnapshot"];
            /** @constant */
            type?: "snapshot.named.info";
        };
        NamedSnapshotListResponse: components["schemas"]["SuccessBase"] & {
            snapshots: components["schemas"]["NamedSnapshot"][];
            /** @constant */
            type?: "snapshot.named.list";
        };
        NamedSnapshotSaveRequest: {
            /** @description Name to save under. 1-63 lowercase letters, digits, or dashes, starting with a letter or digit. Reusing one of your existing names replaces that snapshot's artifact. `latest`, `tree`, `pull`, `rm`, `save`, `current`, `self`, and `new` are reserved. */
            name: string;
            /** @description The sandbox whose current state to freeze. */
            sandboxId: string;
        };
        NamedSnapshotSavingResponse: components["schemas"]["SuccessBase"] & {
            snapshot: components["schemas"]["NamedSnapshot"];
            /** @constant */
            status: "saving";
            /** @constant */
            type?: "snapshot.named.saving";
        };
        Org: {
            /** @description The wallet new sandboxes bill when a request names none. */
            active: boolean;
            /** @description Your account id for the personal row, `team_…` for an organization. */
            id: string;
            memberCount: number;
            /** @description Accepted wherever an org is passed, like the id. */
            name: string;
            /** @enum {string} */
            role: "owner" | "member";
            /** @description Stripe status of the organization's plan; absent on the personal row. */
            subscriptionStatus?: string;
            /** @enum {string} */
            type: "personal" | "org";
        };
        OrgListResponse: components["schemas"]["SuccessBase"] & {
            /** @description Whether this account ever set its active wallet. `false` means personal by default, never a choice. */
            activeWalletChosen: boolean;
            orgs: components["schemas"]["Org"][];
            /** @constant */
            type?: "org.list";
        };
        PageInfo: {
            hasMore: boolean;
            limit: number;
            nextCursor: string | null;
        };
        PromptEvent: {
            /** @description The conversation this prompt belongs to. */
            conversationId?: string | null;
            data: {
                attachments?: {
                    base64Data?: string;
                    filename?: string;
                    mimeType?: string;
                }[];
                /** @description Earlier chat events quoted in this prompt. */
                citations?: {
                    author?: string;
                    eventId?: string;
                    text?: string;
                    type?: string;
                }[];
                /** @description Why the prompt failed. Present only when `status` is `failed`. */
                error?: string;
                is_reverted?: boolean;
                prompt: string;
                /** @enum {string} */
                status: "sending" | "queued" | "running" | "finished" | "failed" | "interrupted";
            };
            id: string;
            taskId?: string | null;
            timestamp: number;
            /** @constant */
            type: "prompt";
        };
        /**
         * @description Work item to queue inside an existing sandbox. Provider credentials must already be configured in the Boat dashboard.
         *
         *     **Providers (harnesses):** `codex`, `claude-code` (alias `claude`), `pi`, `opencode`, `prime-agent` (alias `prime`), `kimi` (Kimi Code CLI, alias `kimi-code`). Omit `provider` to use the harness the user selected on the Agents dashboard.
         *
         *     **Models & reasoning effort** are harness- and model-specific and change over time. Fetch the live catalog (every provider's models and which reasoning-effort levels each accepts) from `GET /provider-models`. Some models accept no reasoning control. `pi`, `opencode` and `prime-agent` also expose models routed through OpenRouter and llmgateway (ids like `openrouter:anthropic/claude-sonnet-4.5`).
         *
         *     **Conversations:** a sandbox runs many conversations in parallel, each with its own history. Set `new: true` to start a fresh conversation, or `conversationId` to continue a specific one; omit both to continue the sandbox's most-recently-active conversation. The response returns the `conversationId` this prompt ran in. Conversations run concurrently up to a per-sandbox limit that scales with the sandbox's memory; beyond it, prompts queue.
         * @example {
         *       "model": "gpt-5.4",
         *       "prompt": "Work on the selected repo, run tests, fix failures, commit the result, and report any hosted preview URL.",
         *       "provider": "codex",
         *       "reasoningEffort": "medium"
         *     }
         * @example {
         *       "new": true,
         *       "prompt": "Start a second, independent task on the auth module while the first keeps running.",
         *       "provider": "claude"
         *     }
         */
        PromptRequest: {
            /**
             * Format: uuid
             * @description Continue a specific conversation by id (as returned by a previous prompt). Omit (and omit `new`) to continue the sandbox's most-recently-active conversation.
             */
            conversationId?: string | null;
            /**
             * @description Optional provider model id from `GET /provider-models`. Omit to use the model selected for that harness on the Agents dashboard. Unknown explicit ids are currently forwarded rather than rejected by request validation.
             * @example gpt-5.6-terra
             * @example claude-sonnet-5
             * @example openrouter:anthropic/claude-sonnet-4.5
             */
            model?: string | null;
            /**
             * @description Start a NEW conversation on the sandbox (runs in parallel with any existing ones) instead of continuing the most-recently-active one. Mutually exclusive with `conversationId`.
             * @example true
             */
            new?: boolean;
            /** @description Natural-language task for the sandbox, including repo, preview, or browser-use instructions. */
            prompt: string;
            /** @enum {string} */
            provider: "codex" | "claude-code" | "claude" | "pi" | "opencode" | "prime-agent" | "prime" | "kimi" | "kimi-code";
            /**
             * @description Optional reasoning/thinking level (e.g. `none`, `low`, `medium`, `high`, `xhigh`, `max`). Which levels a given model accepts is listed per model in `GET /provider-models`; some models accept none.
             * @example high
             */
            reasoningEffort?: string | null;
        };
        PromptResponse: components["schemas"]["SuccessBase"] & {
            /** @description The conversation this prompt was queued in. A new one when `new` was set, the one named by `conversationId`, or the sandbox's most-recently-active conversation. See [Integrated agents](/integrated-agents). */
            conversationId?: string | null;
            /** @description Sandbox id. */
            id: string;
            model?: string | null;
            promptId: string;
            promptRun: components["schemas"]["PromptRun"];
            provider: string;
            reasoningEffort?: string | null;
            /** @enum {string} */
            status: "queued";
            /** @constant */
            type?: "prompt.queued";
        };
        PromptRun: {
            /** @description The conversation this prompt ran in. A Sandbox runs many conversations in parallel; see [Integrated agents](/integrated-agents). */
            conversationId?: string | null;
            /** Format: date-time */
            createdAt?: string | null;
            done: boolean;
            id: string;
            model?: string | null;
            promptId: string;
            reasoningEffort?: string | null;
            sandboxId: string;
            /** @enum {string} */
            status: "sending" | "queued" | "running" | "finished" | "failed" | "interrupted";
        };
        PromptRunResponse: components["schemas"]["SuccessBase"] & {
            id: string;
            promptRun: components["schemas"]["PromptRun"];
            /** @constant */
            type?: "prompt.run";
        };
        /**
         * @description Idempotently selects a repository for future sandboxes. If the repository is already selected, the API updates its base branch instead of returning a conflict.
         * @example {
         *       "baseBranch": "dev",
         *       "repositoryId": "repo_org_123"
         *     }
         */
        RepoSelectionRequest: {
            /** @default main */
            baseBranch?: string;
            /** @description Internal repository `databaseId` returned by `GET /repos`. */
            repositoryId: string;
        };
        RepoSelectionResponse: components["schemas"]["SuccessBase"] & {
            environmentId: string;
            selectedRepositories: components["schemas"]["SelectedRepository"][];
            /** @description Id of the default environment. `environmentId` is the id of its new version. */
            subenvironmentId?: string | null;
            success: boolean;
        };
        ReposResponse: components["schemas"]["SuccessBase"] & {
            environmentId: string;
            installations: components["schemas"]["RepositoryInstallation"][];
            pageInfo?: components["schemas"]["PageInfo"];
            selectedRepositories: components["schemas"]["SelectedRepository"][];
            /** @description Id of the default environment. `environmentId` is the id of its latest version. */
            subenvironmentId?: string | null;
        };
        Repository: {
            /** @description Internal repository id used when selecting repositories. */
            databaseId?: string;
            description?: string | null;
            /** @example acme/web */
            fullName?: string;
            /** @description GitHub repository id. */
            id?: number;
            /**
             * Format: date-time
             * @description Reserved; always null.
             */
            lastUserCommitAt?: string | null;
            name?: string;
            permissions?: string;
            private?: boolean;
            /** Format: date-time */
            pushedAt?: string | null;
            /**
             * Format: uri
             * @example https://github.com/acme/web
             */
            url?: string;
        } & {
            [key: string]: unknown;
        };
        RepositoryInstallation: {
            /** Format: uri */
            accountAvatarUrl?: string | null;
            /** @example acme */
            accountLogin?: string;
            repositories?: components["schemas"]["Repository"][];
            /** @example Organization */
            type?: string;
        };
        /** @description Agent response event. Text deltas/finals and tool-call batches are both represented as response events; tool-call batches have `data.tools`. */
        ResponseEvent: {
            /** @description The conversation this response belongs to. */
            conversationId?: string | null;
            data: {
                content: string;
                is_reverted?: boolean;
                /** @description True when this response is a streaming partial rather than the final assistant message. */
                is_streaming?: boolean;
                model?: string | null;
                /** @description Tool call/result records emitted by the agent. Present for tool-call events and omitted for text-only response events. */
                tools?: {
                    [key: string]: unknown;
                }[];
            };
            id: string;
            taskId?: string | null;
            timestamp: number;
            /** @constant */
            type: "response";
        };
        /**
         * @description Options for resuming a stopped sandbox.
         * @example {
         *       "ttlSeconds": 28800
         *     }
         * @example {
         *       "ttlSeconds": 3600,
         *       "type": "large"
         *     }
         */
        ResumeRequest: {
            /** @description Replaces the sandbox's per-sandbox environment variables. Omit to keep the sandbox's current env. Same validation rules as `CreateSandboxRequest.env`. */
            env?: {
                [key: string]: string;
            };
            /**
             * @description Optionally re-pin the sandbox to a different named sandbox environment on resume. Omit to keep the sandbox's current environment. Unknown names are rejected with `unknown_environment`.
             * @example base
             * @example customer-demos
             */
            environment?: string;
            /** @description Resume into a no-env sandbox: withhold account secrets and scrub inherited owner secrets from the restored snapshot before the sandbox is exposed. One-way; once a sandbox is resumed as no-env it stays no-env on later resumes. */
            noEnv?: boolean;
            /** @description Auto-stop for the resumed sandbox, in seconds, stored on the sandbox. Omit to keep the TTL the sandbox already had. `null` disables auto-stop, which means nothing will ever stop this sandbox for you. */
            ttlSeconds?: number | null;
            /**
             * @description Resume onto a different machine size. Omit to keep the sandbox's current type. A resume already restores onto a fresh machine, so changing size costs nothing extra. Shrinking is rejected with `type_too_small` when the sandbox's data would not fit the smaller disk.
             * @enum {string}
             */
            type?: "small" | "default" | "large";
        };
        Sandbox: {
            /**
             * Format: date-time
             * @description Automatic archival time, or null when auto-stop is disabled.
             */
            archiveAfter?: string | null;
            /**
             * @description Rate at which this sandbox consumes machine time. 0.5 for `small`, 1 for `default`, and 2 for `large`.
             * @example 1
             */
            billingMultiplier?: number;
            /** Format: date-time */
            createdAt?: string | null;
            desktopAvailable: boolean;
            /**
             * Format: uri
             * @description Secret-bearing desktop stream URL when available. Redact from logs.
             */
            desktopUrl?: string | null;
            /**
             * @description Name of the sandbox environment this sandbox is running, or null if it is attached to none (a `noEnv` sandbox, or one whose environment was deleted). A sandbox freezes onto one environment version when it starts and keeps it for life, so this is what the sandbox actually holds, not what the environment says today.
             * @example base
             */
            environment?: string | null;
            /**
             * @description Version number of `environment` that this sandbox is pinned to. Compare it against the environment's latest version to see whether an upgrade is pending: a sandbox below the latest is still running the older configuration until someone calls `POST /environments/{environmentId}/upgrade`.
             * @example 3
             */
            environmentVersion?: number | null;
            /** @description Why the sandbox is stopped, failed or cancelled, or null. */
            error?: string | null;
            /** @example bx_23456789 */
            id: string;
            /** @description Machine IPv6 or IPv4 address when assigned. */
            ip?: string | null;
            /**
             * Format: date-time
             * @description Timestamp of the most recent snapshot attempt of any status (queued, in_progress, completed, failed, cancelled), or null. Use with snapshotCompletedAt to detect snapshots that keep failing.
             */
            lastSnapshotAttemptAt?: string | null;
            /**
             * @description Status of the most recent snapshot attempt, or null if none. A value other than completed while snapshotCompletedAt stays stale indicates failing snapshots.
             * @enum {string|null}
             */
            lastSnapshotStatus?: "queued" | "in_progress" | "completed" | "failed" | "cancelled" | null;
            /**
             * @description Machine provider of the machine the sandbox is on, or null when it has no machine.
             * @enum {string|null}
             */
            machineProvider?: "hetzner" | "baremetal" | null;
            /**
             * @description RAM in GB guaranteed by this sandbox's type.
             * @example 8
             */
            memoryGB?: number;
            /** @example Boat 2026-05-31 12:00 */
            name: string;
            /** @description Short failure detail (exit code plus a stderr tail) when `setupStatus` is `failed`; while `pending`, may carry the last start/upload error from a retry in progress. Otherwise null. */
            setupError?: string | null;
            /**
             * @description Outcome of the create-time `setupScript`: `pending` (stored, not yet started), `running` (executing on the sandbox in the background), `done` (exit code 0) or `failed` (non-zero exit, or the sandbox lost track of the process). Null when the sandbox was created without a setup script.
             * @enum {string|null}
             */
            setupStatus?: "pending" | "running" | "done" | "failed" | null;
            snapshotAvailable: boolean;
            /**
             * Format: date-time
             * @description Timestamp of the most recent successfully completed snapshot, or null.
             */
            snapshotCompletedAt?: string | null;
            /**
             * Format: date-time
             * @description Last time a snapshot confirmed the sandbox's saved state, including checks that found nothing new to save. Falls back to `snapshotCompletedAt`; null if never.
             */
            snapshotVerifiedAt?: string | null;
            /**
             * @description Public IPv4 `host:port` that forwards to the sandbox SSH server. Set only when the machine has no public IPv4 of its own; null otherwise. Connect with `ssh -p <port> user@<host>`.
             * @example 203.0.113.10:22001
             */
            sshEndpoint?: string | null;
            /**
             * @description `cancelled` is terminal: a create or fork that could not get a machine was removed. `GET /sandboxes/{sandboxId}` reports it once, with only `id`, `state` and `error`, then answers 404.
             * @enum {string}
             */
            state: "init" | "provisioning" | "provisioned" | "cloning" | "ready" | "idle" | "running" | "archiving" | "archived" | "error" | "cancelled";
            /** @description The sandbox's stable three-word subdomain slug (e.g. "frazil-pneuma-rallye"), or null before one is assigned. */
            subdomain?: string | null;
            /** @description The organization billed for this sandbox, or null when the owner is billed. */
            team?: {
                id: string;
                name: string;
            } | null;
            /**
             * @description Current machine size: what the sandbox was created with, or the size it was last resumed or forked onto.
             * @enum {string}
             */
            type?: "small" | "default" | "large";
            /** Format: date-time */
            updatedAt?: string | null;
            /**
             * Format: uri
             * @description Machine URL when assigned.
             */
            url?: string | null;
            /**
             * @description vCPUs guaranteed by this sandbox's type.
             * @example 4
             */
            vcpu?: number;
        };
        SandboxActionResponse: components["schemas"]["SuccessBase"] & {
            /** @description On interrupt, the conversation whose turn was interrupted. */
            conversationId?: string;
            /** @description Present on resume or fork when a fair-use cap on a gifted account shortened the requested auto-stop time. */
            giftLimitNotice?: string;
            id: string;
            sandbox?: components["schemas"]["Sandbox"] | null;
            /** @example archiving */
            status: string;
            /** @example sandbox.stopping */
            type?: string;
        };
        /** @description A named sandbox environment. All flags/contents reflect the latest version. */
        SandboxEnvironment: {
            /** @description The latest version's .env-style content. Treat as sensitive. */
            envContents: string;
            /** Format: uuid */
            id: string;
            /** @description Exactly one environment is the default; sandboxes created without an `environment` name use it. */
            isDefault: boolean;
            /** Format: uuid */
            latestVersionId: string | null;
            /**
             * @description Number of the latest version, 0 when there is none.
             * @example 3
             */
            latestVersionNumber?: number;
            /**
             * @example base
             * @example customer-demos
             */
            name: string;
            /** @description Attach agent-provider credentials configured on the Agents page. Ignored when `safeForThirdParties` is true. */
            passAgentsCredentials: boolean;
            /** @description Attach the environment's GitHub repositories and the GitHub token (so `gh` and pushes work). Ignored when `safeForThirdParties` is true. */
            passGithub: boolean;
            /** @description Attach the sandbox's own service/preview credentials. Ignored when `safeForThirdParties` is true. */
            passSandboxCredentials: boolean;
            /** @description Attach the environment's env variables and secret files. Ignored when `safeForThirdParties` is true. */
            passSecrets: boolean;
            /** @description When true the environment passes nothing to a sandbox (repos, secrets, and all credentials withheld), overriding the fine-grained flags below. Use for sandboxes handed to third parties. */
            safeForThirdParties: boolean;
            /**
             * Format: date-time
             * @description When the owner last answered whether this environment is safe for third parties, or null if never asked.
             */
            safetyAnsweredAt?: string | null;
            secretFiles: components["schemas"]["SecretFile"][];
            /** @description Repositories attached to the latest version, with base branch and setup script. */
            selectedRepositories?: components["schemas"]["SelectedRepository"][];
            versions: components["schemas"]["SandboxEnvironmentVersionSummary"][];
        };
        SandboxEnvironmentListResponse: {
            environments: components["schemas"]["SandboxEnvironment"][];
            /** @constant */
            ok?: true;
            /** @constant */
            type?: "environments.list";
        };
        SandboxEnvironmentResponse: {
            environment?: components["schemas"]["SandboxEnvironment"] | null;
            success: boolean;
        };
        /** @description An immutable snapshot of an environment's config. Editing an environment mints a new version; sandboxes stay pinned to the version they were created on until upgraded. */
        SandboxEnvironmentVersionSummary: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            id: string;
            /** @description Number of the caller's active sandboxes currently pinned to this version. */
            sandboxCount: number;
            /** @description Monotonically increasing per environment; version 1 is the first. */
            versionNumber: number;
        };
        SandboxEvent: {
            /** @description The conversation this event belongs to. Filter the stream with `?conversation=<id>`. See [Integrated agents](/integrated-agents). */
            conversationId?: string | null;
            data?: {
                [key: string]: unknown;
            };
            id?: string;
            taskId?: string | null;
            timestamp?: number;
            type: string;
        } & {
            [key: string]: unknown;
        };
        SandboxInfoResponse: components["schemas"]["SuccessBase"] & {
            /** @description Present when a fair-use cap on a gifted account shortened the requested auto-stop time. */
            giftLimitNotice?: string;
            sandbox: components["schemas"]["Sandbox"];
            /** @example sandbox.info */
            type?: string;
        };
        SandboxListResponse: components["schemas"]["SuccessBase"] & {
            pageInfo?: components["schemas"]["PageInfo"];
            sandboxes: components["schemas"]["Sandbox"][];
            /** @constant */
            type?: "sandbox.list";
        };
        SandboxUsageResponse: components["schemas"]["SuccessBase"] & {
            /**
             * @description Rate at which this sandbox consumes machine time. 0.5 for `small`, 1 for `default`, and 2 for `large`.
             * @example 1
             */
            billingMultiplier: number;
            /**
             * @description `seconds` at list price (`seconds / secondsPerDollar`), whatever plan, trial or gift actually paid for it. Up to six decimals.
             * @example 0.0498
             */
            dollars: number;
            /** @description The meter is still moving: the sandbox is up and no refused stop is holding it paused. Read again after it stops for the final figure. `false` on a sandbox that is up but paused past a refused stop, whose figure will not change until it is used again. */
            running: boolean;
            /** @example bx_23456789 */
            sandboxId: string;
            /**
             * @description The sandbox's current machine size, which sets `billingMultiplier`.
             * @enum {string}
             */
            sandboxType: "small" | "default" | "large";
            /**
             * @description Billable machine-seconds inside the window, the type multiplier already applied: a `large` sandbox that ran ten minutes reads 1200. Includes a running sandbox's time up to `until`. Time while stopped is never counted and time past a refused stop is excluded.
             * @example 4980
             */
            seconds: number;
            /**
             * @description How many billable seconds one dollar buys, so you can price `seconds` yourself.
             * @example 100000
             */
            secondsPerDollar: number;
            /**
             * Format: date-time
             * @description Start of the window the figures cover. The sandbox's creation time when the request did not pass `since`.
             */
            since: string;
            /** @example sandbox.usage */
            type?: string;
            /**
             * Format: date-time
             * @description End of the window. Now when the request did not pass `until`, or passed one in the future.
             */
            until: string;
        };
        SecretFile: {
            /** @description Secret file contents. Treat as sensitive. */
            contents: string;
            /** @example .config/service-account.json */
            path: string;
        };
        SecretsResponse: components["schemas"]["SuccessBase"] & {
            envContents: string;
            environmentId: string;
            /** @description Present on update; counts how many active sandboxes received the new environment. */
            pushed?: {
                [key: string]: unknown;
            };
            secretFiles: components["schemas"]["SecretFile"][];
            /** @description Id of the default environment. `environmentId` is the id of its latest version. */
            subenvironmentId?: string;
            success?: boolean;
        };
        /**
         * @description Full replacement for the sandbox secret setup. Omitted `envContents` or `secretFiles` are treated as empty values, and successful updates are pushed to active sandboxes.
         * @example {
         *       "envContents": "OPENAI_API_KEY=sk-...\nDATABASE_URL=postgres://...",
         *       "secretFiles": [
         *         {
         *           "contents": "{\"type\":\"service_account\"}",
         *           "path": ".config/service-account.json"
         *         }
         *       ]
         *     }
         */
        SecretsUpdateRequest: {
            /** @description Full .env-style content to sync into sandboxes. Send the complete desired file contents, not a patch. */
            envContents?: string;
            /** @description Full list of secret files to keep configured. Send existing files again if they should remain. */
            secretFiles?: components["schemas"]["SecretFile"][];
        };
        SelectedRepository: components["schemas"]["Repository"] & {
            /** @example main */
            baseBranch?: string;
            setupBlocking?: boolean;
            setupRoutineId?: string | null;
            setupScript?: string;
        };
        SnapshotChunk: {
            chunkIndex: number;
            generation: number;
            r2Key: string;
            sha256: string | null;
            /**
             * Format: uri
             * @description Time-limited download URL (see `expiresInSeconds`).
             */
            signedUrl: string;
            sizeBytes: number | null;
            /** Format: uuid */
            snapshotId: string;
        };
        SnapshotDownloadResponse: components["schemas"]["SuccessBase"] & {
            /** @description Every chunk across the chain (all generations up to and including this snapshot), ordered by `(generation, chunkIndex)`. */
            chunks: components["schemas"]["SnapshotChunk"][];
            /** @description Lifetime of every `signedUrl` in this response. */
            expiresInSeconds: number;
            generation: number;
            inventory?: {
                r2Key: string;
                /** Format: uri */
                signedUrl: string;
            } | null;
            /** @enum {string} */
            kind: "base" | "incremental" | "legacy";
            /** @description Human-readable note on how to reassemble the chunks into a filesystem. */
            reconstruct: string;
            sandboxId: string;
            /** Format: uuid */
            snapshotId: string;
            /** @constant */
            type?: "snapshot.download";
        };
        SnapshotLatestResponse: components["schemas"]["SuccessBase"] & {
            snapshot: components["schemas"]["SnapshotSummary"] | null;
            /** @constant */
            type?: "snapshot.latest";
        };
        SnapshotListResponse: components["schemas"]["SuccessBase"] & {
            pageInfo?: components["schemas"]["PageInfo"];
            snapshots: components["schemas"]["SnapshotSummary"][];
            /** @constant */
            type?: "snapshot.list";
        };
        SnapshotSummary: {
            /** Format: uuid */
            chainId?: string | null;
            /** Format: date-time */
            completedAt?: string | null;
            /** @description Number of your files restored by this snapshot (base image excluded). `null` on legacy snapshots. */
            contentFileCount?: number | null;
            /** @description Total bytes of your data restored by this snapshot (what resume/download returns; base image excluded). `null` on legacy snapshots. */
            contentSizeBytes?: number | null;
            /** Format: date-time */
            createdAt: string;
            /** @description Inventory entries alive in the chain at this generation (includes base-image system entries). */
            fileCount: number | null;
            /** @description Position in the incremental chain (0 = base). */
            generation: number | null;
            /** Format: uuid */
            id: string;
            /**
             * @description `base` (full) or `incremental` (delta on a base). `null` for legacy snapshots.
             * @enum {string|null}
             */
            kind?: "base" | "incremental" | null;
            /** @description Public Sandbox id this snapshot belongs to. */
            sandboxId: string;
            /** @description Bytes this snapshot added (its delta), not the full restored size. */
            sizeBytes: number | null;
            /** @enum {string} */
            status: "completed";
        };
        SnapshotTreeEntry: {
            /** @enum {string} */
            kind: "file" | "dir" | "symlink";
            /** @description Path relative to the snapshot root. Docker named volumes appear under `__dockervol__/`. */
            path: string;
            /** @description File size in bytes. Omitted for directories. */
            size?: number;
        };
        SnapshotTreeResponse: components["schemas"]["SuccessBase"] & {
            /** @description Exactly the files/dirs a resume or download returns, your data only; base-image system entries are not listed. */
            entries: components["schemas"]["SnapshotTreeEntry"][];
            /** @description Number of your files in this snapshot (base-image system files excluded). */
            fileCount: number;
            generation: number;
            /**
             * @description Why the tree is unavailable, when `treeAvailable` is `false`.
             * @example legacy_snapshot
             * @example inventory_too_large
             */
            reason?: string;
            sandboxId: string;
            /** Format: uuid */
            snapshotId: string;
            /** @description Total bytes of your data in this snapshot (base-image system files excluded). */
            totalSizeBytes: number;
            /** @description `false` for legacy snapshots or inventories too large to expand; see `reason`. */
            treeAvailable: boolean;
            /** @description `true` when the file list was capped; not every entry is returned. */
            truncated: boolean;
            /** @constant */
            type?: "snapshot.tree";
        };
        SshKeyRequest: {
            /**
             * @description Public SSH key in OpenSSH format. Private keys are rejected.
             * @example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@host
             */
            key: string;
        };
        SshKeyResponse: components["schemas"]["SuccessBase"] & {
            /**
             * @description The sandbox SSH server's public host key. Pin it in `known_hosts`.
             * @example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
             */
            hostKey?: string;
            machineIp?: string | null;
            /**
             * @description Public IPv4 `host:port` that forwards to the sandbox SSH server, set only when the machine has no public IPv4 of its own. Connect with `ssh -p <port> user@<host>`.
             * @example 203.0.113.10:22001
             */
            sshEndpoint?: string | null;
            /** @example user */
            sshUser?: string;
            success?: boolean;
        };
        /** @description One rolling start window. Null when the account is unlimited. */
        StartWindowUsage: {
            limit?: number;
            remaining?: number;
            used?: number;
        } | null;
        /** @description A message sent into a turn that was already running, via `POST /sandboxes/{sandboxId}/steer`. It is not a prompt run; the output it causes belongs to the turn that was already running. */
        SteerEvent: {
            /** @description The conversation whose running turn was steered. */
            conversationId?: string | null;
            data: {
                message: string;
                /**
                 * @description `native`: the harness folded the message into the running turn. `native-continued`: the harness accepted it but its turn ended without acting on it, so Boat ran it immediately as its own turn on the same session (nothing interrupted, the instruction lands one turn boundary later). `fallback`: the harness has no mid-turn primitive, so Boat interrupted that turn and continued the same conversation with the instruction. `late`: the turn had already finished, so it ran as an ordinary new turn.
                 * @enum {string}
                 */
                mode: "native" | "native-continued" | "fallback" | "late";
                /** @description True when the turn that was already running took the message (both native modes); false when Boat interrupted that turn and immediately continued the same conversation with it. */
                native: boolean;
            };
            id: string;
            /** @description Id of the steer record, as returned by POST /steer. */
            taskId?: string | null;
            timestamp: number;
            /** @constant */
            type: "steer";
        };
        /**
         * @description A message for a turn that is ALREADY RUNNING. The agent takes it into account and keeps what it was doing, instead of queueing behind the turn (`POST /prompt`) or stopping it (`POST /interrupt`).
         *
         *     **Conversations:** omit `conversation` to steer the sandbox's most-recently-active conversation, exactly like `POST /prompt` chooses one. Pass a `conversation` id to steer a specific one while the others keep running.
         *
         *     The response's `native` says how the harness took it. See [Integrated agents](/integrated-agents).
         * @example {
         *       "message": "Also write /home/user/steered.txt containing the word STEERED, then finish."
         *     }
         * @example {
         *       "conversation": "8f1c2b7a-3d4e-4f5a-9b0c-1d2e3f4a5b6c",
         *       "message": "Skip the integration tests, unit tests are enough."
         *     }
         */
        SteerRequest: {
            /**
             * Format: uuid
             * @description Conversation id to steer. Omit to steer the sandbox's most-recently-active conversation.
             */
            conversation?: string | null;
            /** @description The extra instruction for the running turn. */
            message: string;
        };
        SteerResponse: components["schemas"]["SuccessBase"] & {
            /** @description The conversation whose running turn was steered. */
            conversationId: string;
            /** @description Sandbox id. */
            id: string;
            /**
             * @description How the message was delivered. `native` and `fallback` mirror the `native` field; `late` means the turn finished between the request and its delivery, so the message ran as an ordinary new turn on the conversation. A steer reported `native` here can settle as `native-continued` on the `steer` event: the harness accepted it but its turn ended without acting on it, so Boat continued it immediately as its own turn on the same session. Read the event for the settled mode.
             * @enum {string}
             */
            mode?: "native" | "fallback" | "late";
            /** @description `true` when the harness accepted the message into the turn that was already running, so nothing was interrupted. `false` when Boat interrupted that turn and immediately continued the SAME conversation with the instruction, which keeps the harness session and all of its memory but may repeat a little of the work in flight. */
            native: boolean;
            /** @description Id of the steer record. It appears in `GET /events` as a `steer` event; it is not a prompt run and has no lifecycle to poll. */
            promptId: string;
            /** @enum {string} */
            status: "steered";
            /** @constant */
            type?: "prompt.steered";
        };
        /** @description Options for stopping a sandbox. */
        StopRequest: {
            /**
             * @description Stop the sandbox even if its disk cannot be snapshotted. Everything written since the last successful snapshot is permanently LOST. Without this, a sandbox whose snapshot pipeline is failing is left running rather than discarding your work, and you are not billed for that time. Only use this after a stop has already been refused.
             * @default false
             */
            force?: boolean;
        };
        SuccessBase: {
            /** @example true */
            ok: boolean;
            /** @description Stable success envelope discriminator added by v1. */
            type: string;
        };
        UnknownEvent: {
            type: string;
        } & {
            [key: string]: unknown;
        };
        /** @description Rename, set-default, and/or edit flags and contents. Any flag or content change mints a new immutable version; existing sandboxes are not touched until you call upgrade. */
        UpdateSandboxEnvironmentRequest: {
            /** @description Full .env-style content for the new version. */
            envContents?: string;
            /** @description Set to true to make this the default environment (clears the flag on the previous default). */
            isDefault?: boolean;
            /** @description New environment name. */
            name?: string;
            passAgentsCredentials?: boolean;
            passGithub?: boolean;
            passSandboxCredentials?: boolean;
            passSecrets?: boolean;
            /** @description Full replacement of the version's repository selection. Each item selects one repository by its internal `databaseId` (from `GET /repos`). */
            repositories?: {
                /** @default main */
                baseBranch?: string;
                /** @description Internal repository databaseId. */
                repositoryId: string;
                setupBlocking?: boolean;
                setupScript?: string;
            }[];
            safeForThirdParties?: boolean;
            secretFiles?: components["schemas"]["SecretFile"][];
        };
        /**
         * @example {
         *       "name": "Customer support run",
         *       "ttlSeconds": 7200
         *     }
         * @example {
         *       "subdomain": "acme-staging"
         *     }
         */
        UpdateSandboxRequest: {
            /** @description New display name. Empty strings are rejected; longer names are truncated to 120 chars by the backend. */
            name?: string;
            /** @description Rename the sandbox's stable subdomain (the `<subdomain>.on.boat.dev` label). Lowercase letters, digits and hyphens; no leading/trailing/double hyphens; cannot end in `-desktop` or `-<number>` (reserved for the desktop and hosted-port URLs). Must be globally unique. The base URL, desktop URL and every live `host <port>` URL are re-pointed to the new name with no downtime and their access tokens preserved; the old URLs stop resolving. On a transient routing error the rename is saved but returns 502 `gateway_error` - retry with the same value to finish activating routes. */
            subdomain?: string;
            /** @description New archival TTL. `null` disables auto-stop. */
            ttlSeconds?: number | null;
        };
        /** @description Repoint active sandboxes to the environment's latest version, scrubbing any owner secrets the new version drops and hot-pushing the new config. */
        UpgradeSandboxEnvironmentRequest: {
            /** @description Restrict the upgrade to these sandbox (agent) ids. Omit to upgrade all of the caller's active sandboxes that are on an older version of this environment. */
            agentIds?: string[];
        };
        UpgradeSandboxEnvironmentResponse: {
            failed: number;
            /** @description Id of the version the sandboxes were moved to. */
            latestVersionId?: string;
            success: boolean;
            upgraded: number;
            /** @description Running sandboxes that received the new configuration now. */
            upgradedLive?: number;
            /** @description Stopped sandboxes moved to the latest version; they pick it up when they next resume. */
            upgradedStopped?: number;
        };
        Webhook: {
            /** Format: date-time */
            createdAt: string;
            events: components["schemas"]["WebhookEventType"][];
            /** @example wh_0123456789abcdef01234567 */
            id: string;
            /** @example Production automation */
            name: string | null;
            /** Format: date-time */
            updatedAt: string;
            /**
             * Format: uri
             * @description Public HTTPS endpoint on port 443.
             * @example https://example.com/hooks/sandbox
             */
            url: string;
        };
        WebhookCreateRequest: {
            events: components["schemas"]["WebhookEventType"][];
            name?: string | null;
            /** Format: uri */
            url: string;
        };
        WebhookDeleteResponse: components["schemas"]["SuccessBase"] & {
            id: string;
        };
        /** @description JSON body sent to the registered endpoint. This is not a v1 success envelope. */
        WebhookEvent: {
            /** Format: date-time */
            createdAt: string;
            data: {
                previousState: string;
                sandbox: {
                    id: string;
                    name: string;
                };
                state: string;
            };
            id: string;
            type: components["schemas"]["WebhookEventType"];
        };
        /** @enum {string} */
        WebhookEventType: "sandbox.ready" | "sandbox.error" | "sandbox.archived" | "sandbox.hydrated";
        WebhookListResponse: components["schemas"]["SuccessBase"] & {
            webhooks: components["schemas"]["Webhook"][];
        };
        WebhookResponse: components["schemas"]["SuccessBase"] & {
            webhook: components["schemas"]["Webhook"];
        };
        WebhookSecretResponse: components["schemas"]["WebhookResponse"] & {
            /** @description Signing secret returned only when created or rotated. */
            secret: string;
        };
        WebhookUpdateRequest: {
            events?: components["schemas"]["WebhookEventType"][];
            name?: string | null;
            /** Format: uri */
            url?: string;
        };
    };
    responses: {
        /** @description Invalid request body or parameters. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Request conflicts with current account or sandbox state. */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Authenticated token is not allowed to perform this action. */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Resource not found. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Account cannot currently create or operate sandboxes. The error body may include a dashboard billing URL, but billing actions are not part of the v1 API. */
        PaymentRequired: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Machine start or concurrent-sandbox limit reached. Create, fork and resume each count as one machine start against your plan's start limits (see the Billing guide; `rate_limited`, naming the window you hit). A sandbox that would exceed your plan's concurrent-sandbox cap is refused with `limit_reached`, or `member_limit_reached` when an organization owner has capped you below the plan. */
        RateLimited: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Missing or invalid bearer token. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
    };
    parameters: {
        /** @description Must exactly equal the target `sandboxId` or `snapshotId`. A missing or mismatched value returns `409` without accepting deletion. */
        ConfirmDelete: string;
        /** @description Opaque pagination cursor returned as `pageInfo.nextCursor`. */
        Cursor: string | null;
        /** @description Optional exactly-once key for creating a sandbox. Send your own opaque, account-unique value (a UUID) to make `POST /sandboxes` safe to retry when the response is lost (network timeout, 5xx): the first request creates the sandbox and binds it to the key; every later request with the **same account, key, and request body** returns that same sandbox instead of creating a second, billable one. Behavior: keys are retained for **24 hours**; a concurrent or early retry while the first sandbox is still being minted returns `409` `idempotency_in_progress` (retry shortly, same key); reusing a key with a **different body** returns `409` `idempotency_key_reused`; timeouts and 5xx are safe to retry with the same key; a create that fails before the sandbox exists releases the key within ~2 minutes so a retry can create the sandbox. Omit the header to keep the default (non-idempotent) behavior. */
        IdempotencyKey: string;
        /** @description Maximum items to return. */
        Limit: number;
        /** @description Deletion operation id returned by an accepted delete request. */
        OperationId: string;
        /** @description Same as the `org` query parameter. Query wins when both are set. */
        OrgHeader: string;
        /** @description Billing wallet for this request: an organization you belong to, by id (`team_…`) or by name as `GET /orgs` lists it (case-insensitive), or `personal`. Omitted, the account's active wallet applies (`PATCH /orgs/active`; personal until set). Two organizations sharing the name answer `409 ambiguous_org` and need the id. Sandboxes, snapshots, and environments stay creator-private. */
        OrgId: string;
        /** @description Process id returned by a detached command start. */
        ProcessId: number;
        /** @description Public Sandbox id returned by create/list/get sandbox calls. */
        SandboxId: string;
        /** @description Snapshot id returned by the snapshot list/latest calls. */
        SnapshotId: string;
        /** @description Sort direction for cursor pagination. */
        Sort: "asc" | "desc";
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getDataRetention: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current retention policy. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DataRetentionPolicyResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    updateDataRetention: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DataRetentionUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated retention policy. Responses are never cached. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DataRetentionPolicyResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    apiKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description API key metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeysResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    createScopedApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    actions?: string[];
                    environmentIds?: string[];
                    name?: string;
                    /** @enum {string} */
                    preset?: "read-only" | "full-sandbox" | "ci" | "admin";
                    sandboxIds?: string[];
                    /**
                     * @description Duration such as 90d, 24h, or seconds. Max 365d.
                     * @example 90d
                     */
                    ttl?: string;
                };
            };
        };
        responses: {
            /** @description Created key metadata plus the one-time secret. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeySecretResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description Scoped credential creation has not been activated yet. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        error: "scoped_api_key_creation_disabled";
                        message: string;
                        /** @enum {boolean} */
                        scopedCreationEnabled: false;
                    };
                };
            };
        };
    };
    revokeApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                apiKeyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Key revoked. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeyRevokeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    rotateApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                apiKeyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Rotated key metadata plus the one-time replacement secret. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeySecretResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description The scoped API key has already expired and cannot be rotated. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        error: "api_key_expired";
                        message: string;
                    };
                };
            };
        };
    };
    apiKeyUsage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description API key ID returned by `GET /api-keys`. */
                apiKeyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Usage and created resources for the key. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeyUsageResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    getDeletionOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Deletion operation id returned by an accepted delete request. */
                operationId: components["parameters"]["OperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current deletion operation state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionOperationResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    environments: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The account's sandbox environments. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxEnvironmentListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    createEnvironment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateSandboxEnvironmentRequest"];
            };
        };
        responses: {
            /** @description Environment created; full list returned. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxEnvironmentListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
        };
    };
    updateEnvironment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Environment id returned by `GET /environments`. */
                environmentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateSandboxEnvironmentRequest"];
            };
        };
        responses: {
            /** @description Updated environment. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxEnvironmentResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteEnvironment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Environment id returned by `GET /environments`. */
                environmentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Environment soft-deleted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxEnvironmentResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    addEnvironmentRepo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default main */
                    baseBranch?: string;
                    /** @description The repository `databaseId` from `GET /repos`. */
                    repositoryId: string;
                };
            };
        };
        responses: {
            /** @description New version minted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvironmentItemChangeResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteEnvironmentRepo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
                /** @description The repository `databaseId`. */
                repositoryId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description New version minted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvironmentItemChangeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    setEnvironmentSecretFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    contents: string;
                    /** @description In-sandbox path relative to the workspace, e.g. `.env` or `repo/.env`. */
                    path: string;
                };
            };
        };
        responses: {
            /** @description New version minted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvironmentItemChangeResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteEnvironmentSecretFile: {
        parameters: {
            query: {
                path: string;
            };
            header?: never;
            path: {
                environmentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description New version minted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvironmentItemChangeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    upgradeEnvironment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["UpgradeSandboxEnvironmentRequest"];
            };
        };
        responses: {
            /** @description Upgrade result counts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpgradeSandboxEnvironmentResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    setEnvironmentVar: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
                /** @description Environment variable name. */
                key: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    value: string;
                };
            };
        };
        responses: {
            /** @description New version minted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvironmentItemChangeResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteEnvironmentVar: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                environmentId: string;
                /** @description Environment variable name. */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description New version minted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnvironmentItemChangeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    limits: {
        parameters: {
            query?: {
                /** @description Billing wallet for this request: an organization you belong to, by id (`team_…`) or by name as `GET /orgs` lists it (case-insensitive), or `personal`. Omitted, the account's active wallet applies (`PATCH /orgs/active`; personal until set). Two organizations sharing the name answer `409 ambiguous_org` and need the id. Sandboxes, snapshots, and environments stay creator-private. */
                org?: components["parameters"]["OrgId"];
                /** @description Legacy alias for `org`. Takes precedence over `org` / `X-Boat-Org` when set. */
                teamId?: string;
            };
            header?: {
                /** @description Same as the `org` query parameter. Query wins when both are set. */
                "X-Boat-Org"?: components["parameters"]["OrgHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current creation and concurrent-boat limits. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LimitsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    me: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current user information. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    listNamedSnapshots: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Named snapshots owned by the authenticated Boat user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NamedSnapshotListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    saveNamedSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NamedSnapshotSaveRequest"];
            };
        };
        responses: {
            /** @description Save accepted and running in the background. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NamedSnapshotSavingResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description `named_snapshot_limit` when you already keep the maximum of 10 named snapshots; remove one first. `save_in_progress` when a save under this name is already running; wait for it to settle rather than retrying immediately. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getNamedSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The named snapshot. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NamedSnapshotInfoResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteNamedSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NamedSnapshotDeletedResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description `save_in_progress`: a save under this name is still running. Wait for it to settle before removing it. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listOrganizations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Personal account and organizations. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrgListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    setActiveOrganization: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ActiveOrgUpdateRequest"];
            };
        };
        responses: {
            /** @description The wallet now active. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActiveOrgResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            /** @description `not_org_member`: no organization with that id or name that you belong to. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /** @description `ambiguous_org`: several of your organizations share that name; pass the id. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    repos: {
        parameters: {
            query?: {
                /** @description When true, sync from GitHub before returning repository groups. */
                sync?: boolean;
                /** @description Maximum items to return. */
                limit?: components["parameters"]["Limit"];
                /** @description Opaque pagination cursor returned as `pageInfo.nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Sort direction for cursor pagination. */
                sort?: components["parameters"]["Sort"];
                /** @description Case-insensitive repository name/fullName filter. */
                q?: string;
                /** @description Filter to selected or unselected repositories. */
                selected?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Repository groups and current sandbox repository selection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReposResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
        };
    };
    selectRepo: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RepoSelectionRequest"];
            };
        };
        responses: {
            /** @description Updated repository selection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepoSelectionResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
        };
    };
    sandboxes: {
        parameters: {
            query?: {
                /** @description Maximum items to return. */
                limit?: components["parameters"]["Limit"];
                /** @description Opaque pagination cursor returned as `pageInfo.nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Sort direction for cursor pagination. */
                sort?: components["parameters"]["Sort"];
                /** @description Comma-separated sandbox state filter, for example `ready,idle,running`. */
                state?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sandboxes owned by the authenticated Boat user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    create: {
        parameters: {
            query?: {
                /** @description Billing wallet for this request: an organization you belong to, by id (`team_…`) or by name as `GET /orgs` lists it (case-insensitive), or `personal`. Omitted, the account's active wallet applies (`PATCH /orgs/active`; personal until set). Two organizations sharing the name answer `409 ambiguous_org` and need the id. Sandboxes, snapshots, and environments stay creator-private. */
                org?: components["parameters"]["OrgId"];
            };
            header?: {
                /** @description Optional exactly-once key for creating a sandbox. Send your own opaque, account-unique value (a UUID) to make `POST /sandboxes` safe to retry when the response is lost (network timeout, 5xx): the first request creates the sandbox and binds it to the key; every later request with the **same account, key, and request body** returns that same sandbox instead of creating a second, billable one. Behavior: keys are retained for **24 hours**; a concurrent or early retry while the first sandbox is still being minted returns `409` `idempotency_in_progress` (retry shortly, same key); reusing a key with a **different body** returns `409` `idempotency_key_reused`; timeouts and 5xx are safe to retry with the same key; a create that fails before the sandbox exists releases the key within ~2 minutes so a retry can create the sandbox. Omit the header to keep the default (non-idempotent) behavior. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
                /** @description Same as the `org` query parameter. Query wins when both are set. */
                "X-Boat-Org"?: components["parameters"]["OrgHeader"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CreateSandboxRequest"];
            };
        };
        responses: {
            /** @description Boat accepted for provisioning. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateSandboxResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
        };
    };
    get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Boat details. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxInfoResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteSandbox: {
        parameters: {
            query?: never;
            header: {
                /** @description Must exactly equal the target `sandboxId` or `snapshotId`. A missing or mismatched value returns `409` without accepting deletion. */
                "X-Ascii-Confirm-Delete": components["parameters"]["ConfirmDelete"];
            };
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deletion confirmed and accepted for background processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionOperationResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    update: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateSandboxRequest"];
            };
        };
        responses: {
            /** @description Updated sandbox details. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxInfoResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    artifact: {
        parameters: {
            query: {
                path: string;
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Artifact bytes. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
        };
    };
    command: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CommandRequest"];
            };
        };
        responses: {
            /** @description Command result (synchronous) or process start confirmation (detached). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CommandResponse"] | components["schemas"]["CommandStartedResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    commandStatus: {
        parameters: {
            query?: {
                /** @description Cap each returned log to its last N bytes. Defaults to 8388608 (8 MiB). */
                tailBytes?: number;
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
                /** @description Process id returned by a detached command start. */
                processId: components["parameters"]["ProcessId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Process status and log tails. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CommandStatusResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    conversations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conversations on the sandbox. A Sandbox that was never prompted returns an empty list. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
        };
    };
    desktop: {
        parameters: {
            query?: {
                /** @description Use VNC/noVNC streaming mode. */
                vnc?: 1;
                /** @description Desktop streaming theme for non-VNC mode. */
                theme?: "light" | "dark";
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["DesktopRequest"];
            };
        };
        responses: {
            /** @description Desktop streaming URL, or provisioning state for VNC setup. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DesktopResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
        };
    };
    events: {
        parameters: {
            query?: {
                /** @description Maximum items to return. */
                limit?: components["parameters"]["Limit"];
                /** @description Opaque pagination cursor returned as `pageInfo.nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Sort direction for cursor pagination. */
                sort?: components["parameters"]["Sort"];
                /** @description Comma-separated event type filter, for example `prompt,response,steer`. */
                type?: string;
                /** @description Only return events for this conversation id. Repeat the parameter (or comma-separate) for several. Omit to stream every conversation on the sandbox. See [Integrated agents](/integrated-agents). */
                conversation?: string;
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The agent's work on the sandbox (prompts, responses), not sandbox lifecycle. A sandbox that was never prompted returns an empty list even though it started, stopped and resumed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EventsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
        };
    };
    readFile: {
        parameters: {
            query: {
                path: string;
                encoding?: "utf8" | "base64";
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File contents. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileReadResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    writeFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FileWriteRequest"];
            };
        };
        responses: {
            /** @description File written. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileWriteResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    fork: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional exactly-once key for creating a sandbox. Send your own opaque, account-unique value (a UUID) to make `POST /sandboxes` safe to retry when the response is lost (network timeout, 5xx): the first request creates the sandbox and binds it to the key; every later request with the **same account, key, and request body** returns that same sandbox instead of creating a second, billable one. Behavior: keys are retained for **24 hours**; a concurrent or early retry while the first sandbox is still being minted returns `409` `idempotency_in_progress` (retry shortly, same key); reusing a key with a **different body** returns `409` `idempotency_key_reused`; timeouts and 5xx are safe to retry with the same key; a create that fails before the sandbox exists releases the key within ~2 minutes so a retry can create the sandbox. Omit the header to keep the default (non-idempotent) behavior. */
                "Idempotency-Key"?: components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @description Replaces the env the fork would otherwise inherit from the source sandbox. Same validation rules as `CreateSandboxRequest.env`. */
                    env?: {
                        [key: string]: string;
                    };
                    /**
                     * @description Optionally pin the fork to a different named sandbox environment. Omit to inherit the source sandbox's environment. Unknown names are rejected with `unknown_environment`.
                     * @example base
                     * @example customer-demos
                     */
                    environment?: string;
                    /** @description Make the fork no-env (see `CreateSandboxRequest.noEnv`). A fork of a no-env sandbox is always no-env regardless of this field. */
                    noEnv?: boolean;
                    /**
                     * @description Auto-stop for the fork, in seconds. Omit for the 1 hour default; the fork does NOT inherit the source sandbox's TTL, so forking a sandbox that has auto-stop disabled still gives you a fork that stops itself. `null` disables auto-stop, which means nothing will ever stop this sandbox for you.
                     * @default 3600
                     */
                    ttlSeconds?: number | null;
                    /**
                     * @description Machine size for the fork. Omit to inherit the source sandbox's type. The source sandbox is never modified. Shrinking is rejected with `type_too_small` when the source's data would not fit the smaller disk.
                     * @enum {string}
                     */
                    type?: "small" | "default" | "large";
                };
            };
        };
        responses: {
            /** @description Fork started. The response `id` is the new forked sandbox id. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxActionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
        };
    };
    hostPort: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HostPortRequest"];
            };
        };
        responses: {
            /** @description The public HTTPS URL for the port. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HostPortResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
        };
    };
    interrupt: {
        parameters: {
            query?: {
                /** @description Interrupt only this conversation id. Omit to interrupt the whole sandbox. */
                conversation?: string;
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Interrupt requested. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxActionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    prompt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PromptRequest"];
            };
        };
        responses: {
            /** @description Prompt queued. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PromptResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    promptRunStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
                promptId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Prompt run status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PromptRunResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    resume: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["ResumeRequest"];
            };
        };
        responses: {
            /** @description Resume started. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxActionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
        };
    };
    listSandboxSnapshots: {
        parameters: {
            query?: {
                /** @description Maximum items to return. */
                limit?: components["parameters"]["Limit"];
                /** @description Opaque pagination cursor returned as `pageInfo.nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Sort direction for cursor pagination. */
                sort?: components["parameters"]["Sort"];
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Completed snapshots for this sandbox. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SnapshotListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteSandboxSnapshots: {
        parameters: {
            query?: never;
            header: {
                /** @description Must exactly equal the target `sandboxId` or `snapshotId`. A missing or mismatched value returns `409` without accepting deletion. */
                "X-Ascii-Confirm-Delete": components["parameters"]["ConfirmDelete"];
            };
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One accepted deletion operation per snapshot. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionOperationListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    getLatestSandboxSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Most recent completed snapshot, or `null`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SnapshotLatestResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    sshKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SshKeyRequest"];
            };
        };
        responses: {
            /** @description SSH key setup result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SshKeyResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
        };
    };
    steer: {
        parameters: {
            query?: {
                /** @description Conversation id to steer. Also accepted in the body. Omit to steer the sandbox's most-recently-active conversation. */
                conversation?: string;
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SteerRequest"];
            };
        };
        responses: {
            /** @description Message delivered to the running turn. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SteerResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            402: components["responses"]["PaymentRequired"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    stop: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["StopRequest"];
            };
        };
        responses: {
            /** @description Boat archival started or already in progress. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxActionResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    usage: {
        parameters: {
            query?: {
                /** @description Count from this time, ISO 8601 or Unix epoch seconds. Default is the sandbox's creation. */
                since?: string;
                /** @description Count up to this time, ISO 8601 or Unix epoch seconds. Default is now. */
                until?: string;
            };
            header?: never;
            path: {
                /** @description Public Sandbox id returned by create/list/get sandbox calls. */
                sandboxId: components["parameters"]["SandboxId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Billable machine time for the sandbox inside the window. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SandboxUsageResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    secrets: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current secret setup metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    updateSecrets: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SecretsUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated secret setup metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    listSnapshots: {
        parameters: {
            query?: {
                /** @description Maximum items to return. */
                limit?: components["parameters"]["Limit"];
                /** @description Opaque pagination cursor returned as `pageInfo.nextCursor`. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Sort direction for cursor pagination. */
                sort?: components["parameters"]["Sort"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Completed snapshots owned by the authenticated Boat user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SnapshotListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    deleteSnapshot: {
        parameters: {
            query?: never;
            header: {
                /** @description Must exactly equal the target `sandboxId` or `snapshotId`. A missing or mismatched value returns `409` without accepting deletion. */
                "X-Ascii-Confirm-Delete": components["parameters"]["ConfirmDelete"];
            };
            path: {
                /** @description Snapshot id returned by the snapshot list/latest calls. */
                snapshotId: components["parameters"]["SnapshotId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deletion confirmed and accepted for background processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionOperationResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    getSnapshotDownload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Snapshot id returned by the snapshot list/latest calls. */
                snapshotId: components["parameters"]["SnapshotId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Signed chunk URLs for the snapshot chain. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SnapshotDownloadResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    getSnapshotFile: {
        parameters: {
            query?: {
                /** @description File or folder path inside the snapshot. Empty for the whole snapshot. */
                path?: string;
            };
            header?: never;
            path: {
                /** @description Snapshot id returned by the snapshot list/latest calls. */
                snapshotId: components["parameters"]["SnapshotId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File bytes (`application/octet-stream`) or folder tar (`application/x-tar`). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                    "application/x-tar": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description Path has no downloadable bytes, one of `legacy_snapshot` (pre-inventory snapshot), `snapshot_not_indexed` (content captured before the indexed snapshot format; take a new snapshot or use the download bundle), `base_image_file` (stock image file, not stored in snapshots), or `is_symlink` (request the symlink's target instead). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getSnapshotTree: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Snapshot id returned by the snapshot list/latest calls. */
                snapshotId: components["parameters"]["SnapshotId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Flat file/folder listing for the snapshot. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SnapshotTreeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    listWebhooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Registered webhook endpoints. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    createWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookCreateRequest"];
            };
        };
        responses: {
            /** @description Webhook created. Store the one-time signing secret now. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookSecretResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
        };
    };
    getWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Webhook metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Webhook deleted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookDeleteResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    updateWebhook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated webhook metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    rotateWebhookSigningSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                webhookId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Signing secret rotated. Store the new secret now. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookSecretResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    deliverSandboxLifecycleEvent: {
        parameters: {
            query?: never;
            header: {
                "X-Ascii-Event": components["schemas"]["WebhookEventType"];
                "X-Ascii-Delivery": string;
                "X-Ascii-Timestamp": string;
                /** @description HMAC-SHA256 over `delivery_id.timestamp.raw_body`, formatted as `v1=<hex>`. */
                "X-Ascii-Signature": string;
                "X-Ascii-Attempt": number;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookEvent"];
            };
        };
        responses: {
            /** @description Delivery accepted. */
            "2XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Delivery will be retried with exponential backoff. */
            default: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
