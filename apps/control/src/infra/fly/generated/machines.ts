// Generated from infra/fly/machines.openapi.json (sha256 44fb4eed723ec173942d0b54680f7c1ed25131af0087c28a21fd13d0468cf4a8) by tools/openapi.
// Do not edit. Regenerate with `bun run openapi:generate`; update the spec with `bun run openapi:update fly`.

export interface paths {
    "/v1/apps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Apps
         * @description List all apps with the ability to filter by organization slug.
         */
        get: operations["Apps_list"];
        put?: never;
        /**
         * Create App
         * @description Create an app with the specified details in the request body.
         */
        post: operations["Apps_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get App
         * @description Retrieve details about a specific app by its name.
         */
        get: operations["Apps_show"];
        put?: never;
        post?: never;
        /**
         * Destroy App
         * @description Delete an app by its name.
         */
        delete: operations["Apps_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/certificates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List certificates for app */
        get: operations["App_Certificates_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/certificates/acme": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request ACME certificate */
        post: operations["App_Certificates_acme_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/certificates/custom": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Upload custom certificate */
        post: operations["App_Certificates_custom_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/certificates/{hostname}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get certificate details */
        get: operations["App_Certificates_show"];
        put?: never;
        post?: never;
        /** Remove certificate */
        delete: operations["App_Certificates_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/certificates/{hostname}/acme": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove ACME certificates */
        delete: operations["App_Certificates_acme_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/certificates/{hostname}/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Check DNS and re-validate certificate */
        post: operations["App_Certificates_check"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/certificates/{hostname}/custom": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove custom certificate */
        delete: operations["App_Certificates_custom_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/deploy_token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create App deploy token */
        post: operations["App_create_deploy_token"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/ip_assignments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List IP assignments for app */
        get: operations["App_IPAssignments_list"];
        put?: never;
        /** Assign new IP address to app */
        post: operations["App_IPAssignments_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/ip_assignments/{ip}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove IP assignment from app */
        delete: operations["App_IPAssignments_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Machines
         * @description List all Machines associated with a specific app, with optional filters for including deleted Machines and filtering by region.
         */
        get: operations["Machines_list"];
        put?: never;
        /**
         * Create Machine
         * @description Create a Machine within a specific app using the details provided in the request body.
         *
         *     **Important**: This request can fail, and you’re responsible for handling that failure. If you ask for a large Machine, or a Machine in a region we happen to be at capacity for, you might need to retry the request, or to fall back to another region. If you’re working directly with the Machines API, you’re taking some responsibility for your own orchestration!
         */
        post: operations["Machines_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Machine
         * @description Get details of a specific Machine within an app by the Machine ID.
         */
        get: operations["Machines_show"];
        put?: never;
        /**
         * Update Machine
         * @description Update a Machine's configuration using the details provided in the request body.
         */
        post: operations["Machines_update"];
        /**
         * Destroy Machine
         * @description Delete a specific Machine within an app by Machine ID, with an optional force parameter to force kill the Machine if it's running.
         */
        delete: operations["Machines_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/cordon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cordon Machine
         * @description “Cordoning” a Machine refers to disabling its services, so the Fly Proxy won’t route requests to it. In flyctl this is used by blue/green deployments; one set of Machines is started up with services disabled, and when they are all healthy, the services are enabled on the new Machines and disabled on the old ones.
         */
        post: operations["Machines_cordon"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Events
         * @description List all events associated with a specific Machine within an app.
         */
        get: operations["Machines_list_events"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/exec": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Execute Command
         * @description Execute a command on a specific Machine and return the raw command output bytes.
         */
        post: operations["Machines_exec"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/lease": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Lease
         * @description Retrieve the current lease of a specific Machine within an app. Machine leases can be used to obtain an exclusive lock on modifying a Machine.
         */
        get: operations["Machines_show_lease"];
        put?: never;
        /**
         * Create Lease
         * @description Create a lease for a specific Machine within an app using the details provided in the request body. Machine leases can be used to obtain an exclusive lock on modifying a Machine.
         */
        post: operations["Machines_create_lease"];
        /**
         * Release Lease
         * @description Release the lease of a specific Machine within an app. Machine leases can be used to obtain an exclusive lock on modifying a Machine.
         */
        delete: operations["Machines_release_lease"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/memory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Machine Memory
         * @description Get current memory limit and available capacity for a machine
         */
        get: operations["Machines_get_memory"];
        /**
         * Set Machine Memory Limit
         * @description Set the memory limit for a machine using the balloon device
         */
        put: operations["Machines_set_memory_limit"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/memory/reclaim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reclaim Machine Memory
         * @description Trigger the balloon device to reclaim memory from a machine
         */
        post: operations["Machines_reclaim_memory"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/metadata": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Metadata
         * @description Retrieve metadata for a specific Machine within an app.
         */
        get: operations["Machines_show_metadata"];
        /**
         * Update Metadata (set/remove multiple keys)
         * @description Update multiple metadata keys at once. Null values and empty strings remove keys.
         *     + If `machine_version` is provided and no longer matches the current machine version, returns 412 Precondition Failed.
         */
        put: operations["Machines_update_metadata_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update Metadata (set/remove multiple keys)
         * @description Update multiple metadata keys at once. Null values and empty strings remove keys.
         *     + If `machine_version` is provided and no longer matches the current machine version, returns 412 Precondition Failed.
         */
        patch: operations["Machines_update_metadata"];
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/metadata/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Metadata Value
         * @description Get the value of a specific metadata key
         */
        get: operations["Machines_get_metadata_key"];
        put?: never;
        /**
         * Upsert Metadata Key
         * @description Update metadata for a specific machine within an app by providing a metadata key.
         */
        post: operations["Machines_upsert_metadata"];
        /**
         * Delete Metadata
         * @description Delete metadata for a specific Machine within an app by providing a metadata key.
         */
        delete: operations["Machines_delete_metadata"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/ps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Processes
         * @description List all processes running on a specific Machine within an app, with optional sorting parameters.
         */
        get: operations["Machines_list_processes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/restart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restart Machine
         * @description Restart a specific Machine within an app, with an optional timeout parameter.
         */
        post: operations["Machines_restart"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/signal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Signal Machine
         * @description Send a signal to a specific Machine within an app using the details provided in the request body.
         */
        post: operations["Machines_signal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start Machine
         * @description Start a specific Machine within an app.
         */
        post: operations["Machines_start"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop Machine
         * @description Stop a specific Machine within an app, with an optional request body to specify signal and timeout.
         */
        post: operations["Machines_stop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/suspend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Suspend Machine
         * @description Suspend a specific Machine within an app. The next start operation will attempt (but is not guaranteed) to resume the Machine from a snapshot taken at suspension time, rather than performing a cold boot.
         */
        post: operations["Machines_suspend"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/uncordon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Uncordon Machine
         * @description “Cordoning” a Machine refers to disabling its services, so the Fly Proxy won’t route requests to it. In flyctl this is used by blue/green deployments; one set of Machines is started up with services disabled, and when they are all healthy, the services are enabled on the new Machines and disabled on the old ones.
         */
        post: operations["Machines_uncordon"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Versions
         * @description List all versions of the configuration for a specific Machine within an app.
         */
        get: operations["Machines_list_versions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/machines/{machine_id}/wait": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Wait for State
         * @description Wait for a Machine to reach a specific state. Specify the desired state with the state parameter. See the [Machine states table](https://fly.io/docs/machines/working-with-machines/#machine-states) for a list of possible states. The default for this parameter is `started`.
         *
         *     This request will block for up to 60 seconds. Set a shorter timeout with the timeout parameter.
         */
        get: operations["Machines_wait"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secretkeys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List secret keys belonging to an app */
        get: operations["Secretkeys_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secretkeys/{secret_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an app's secret key */
        get: operations["Secretkey_get"];
        put?: never;
        /** Create or update a secret key */
        post: operations["Secretkey_set"];
        /** Delete an app's secret key */
        delete: operations["Secretkey_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secretkeys/{secret_name}/decrypt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decrypt with a secret key */
        post: operations["Secretkey_decrypt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secretkeys/{secret_name}/encrypt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Encrypt with a secret key */
        post: operations["Secretkey_encrypt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secretkeys/{secret_name}/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Generate a random secret key */
        post: operations["Secretkey_generate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secretkeys/{secret_name}/sign": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign with a secret key */
        post: operations["Secretkey_sign"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secretkeys/{secret_name}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify with a secret key */
        post: operations["Secretkey_verify"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List app secrets belonging to an app */
        get: operations["Secrets_list"];
        put?: never;
        /** Update app secrets belonging to an app */
        post: operations["Secrets_update"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/secrets/{secret_name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an app secret */
        get: operations["Secret_get"];
        put?: never;
        /** Create or update Secret */
        post: operations["Secret_create"];
        /** Delete an app secret */
        delete: operations["Secret_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/volumes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Volumes
         * @description List all volumes associated with a specific app.
         */
        get: operations["Volumes_list"];
        put?: never;
        /**
         * Create Volume
         * @description Create a volume for a specific app using the details provided in the request body.
         */
        post: operations["Volumes_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/volumes/{volume_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Volume
         * @description Retrieve details about a specific volume by its ID within an app.
         */
        get: operations["Volumes_get_by_id"];
        /**
         * Update Volume
         * @description Update a volume's configuration using the details provided in the request body.
         */
        put: operations["Volumes_update"];
        post?: never;
        /**
         * Destroy Volume
         * @description Delete a specific volume within an app by volume ID.
         */
        delete: operations["Volume_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/volumes/{volume_id}/extend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Extend Volume
         * @description Extend a volume's size within an app using the details provided in the request body.
         */
        put: operations["Volumes_extend"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/apps/{app_name}/volumes/{volume_id}/snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Snapshots
         * @description List all snapshots for a specific volume within an app.
         */
        get: operations["Volumes_list_snapshots"];
        put?: never;
        /**
         * Create Snapshot
         * @description Create a snapshot for a specific volume within an app.
         */
        post: operations["createVolumeSnapshot"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/orgs/{org_slug}/machines": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List All Machines
         * @description List all Machines associated with a specific organization. Machines are sorted by their `updated_at` timestamps, oldest to newest.
         *
         *     This API call represents "a point in time". Recent machine changes, including creations and destructions, may take time to propagate. When polling with `updated_after`, offset your timestamps to catch late-arriving events.
         */
        get: operations["Machines_org_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/orgs/{org_slug}/volumes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List All Volumes
         * @description List all volumes for an organization with optional filters and cursor-based pagination.
         */
        get: operations["Volumes_org_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/platform/placements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get Placements
         * @description Simulates placing the specified number of machines into regions, depending on available capacity and limits.
         */
        post: operations["Platform_placements_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/platform/regions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Regions
         * @description List all regions on the platform with their details.
         */
        get: operations["Platform_regions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Postgres Clusters
         * @description List Managed Postgres clusters for an organization.
         */
        get: operations["Postgres_list"];
        put?: never;
        /**
         * Create Postgres Cluster
         * @description Create a Managed Postgres cluster for the organization named in the request body. Provisioning is asynchronous: poll `GET /v1/postgres/{id}` until `status == ready` before calling database, user, extension, or credential endpoints.
         */
        post: operations["Postgres_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Postgres Cluster
         * @description Get details of a specific Managed Postgres cluster.
         */
        get: operations["Postgres_show"];
        put?: never;
        post?: never;
        /**
         * Delete Postgres Cluster
         * @description Delete a Managed Postgres cluster. The cluster is marked for deletion and removed asynchronously.
         */
        delete: operations["Postgres_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/attachments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Attach Cluster to App
         * @description Record an attachment between a cluster and a Fly app. This endpoint records the relationship but does not set DATABASE_URL or other app secrets; configure the connection string separately. The attachment is created if it does not already exist.
         */
        post: operations["Postgres_attachments_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/attachments/{app_name}": {
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
         * Detach Cluster from App
         * @description Detach a specific cluster from a Fly app.
         */
        delete: operations["Postgres_attachments_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/backups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Backups
         * @description List all backups associated with a specific cluster.
         */
        get: operations["Postgres_backups_list"];
        put?: never;
        /**
         * Create Backup
         * @description Create a backup for a specific cluster. The backup runs asynchronously and is rejected if one is already in progress.
         */
        post: operations["Postgres_backups_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/databases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Databases
         * @description List all databases within a specific cluster.
         */
        get: operations["Postgres_databases_list"];
        put?: never;
        /**
         * Create Database
         * @description Create a database within a specific cluster.
         */
        post: operations["Postgres_databases_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/databases/{database_name}": {
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
         * Drop Database
         * @description Delete a specific database within a cluster, along with objects that depend on it.
         */
        delete: operations["Postgres_databases_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/databases/{database_name}/extensions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Extensions
         * @description List all extensions available within a specific database, indicating which are installed.
         */
        get: operations["Postgres_extensions_list"];
        put?: never;
        /**
         * Enable Extension
         * @description Enable a Postgres extension within a specific database. PostGIS extensions require a PostGIS-enabled cluster.
         */
        post: operations["Postgres_extensions_enable"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/databases/{database_name}/extensions/{extension_name}": {
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
         * Disable Extension
         * @description Disable a specific Postgres extension within a database, optionally dropping objects that depend on it. System extensions cannot be disabled.
         */
        delete: operations["Postgres_extensions_disable"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/fork": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fork Cluster to New Cluster
         * @description Fork a ready Managed Postgres cluster into a new cluster that inherits the source's settings. The source cluster is left unchanged, and the fork is provisioned asynchronously.
         */
        post: operations["Postgres_fork"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/queries/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Active Queries
         * @description List active queries in the supplied database. The database query parameter is required and must not be empty or whitespace-only. Returns full query text and durations in seconds.
         */
        get: operations["Postgres_queries_active"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/queries/slow": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Slow Queries
         * @description List the top 20 queries by cumulative total execution time, excluding the postgres database. Uses the latest available metrics within the lookback range; statistics are cumulative PostgreSQL counters, not deltas over that range. Returns full query text and execution times in seconds.
         */
        get: operations["Postgres_queries_slow"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore Backup or Point in Time to New Cluster
         * @description Restore a backup, or a point in time within the cluster's PITR recovery window, into a new Managed Postgres cluster. The source cluster is left unchanged, and a new cluster is provisioned asynchronously.
         */
        post: operations["Postgres_restore"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Users
         * @description List all Postgres users within a specific cluster.
         */
        get: operations["Postgres_users_list"];
        put?: never;
        /**
         * Create User
         * @description Create a Postgres user within a specific cluster. Fetch the generated password from the credentials endpoint.
         */
        post: operations["Postgres_users_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/users/{username}": {
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
         * Delete User
         * @description Delete a specific Postgres user within a cluster.
         */
        delete: operations["Postgres_users_delete"];
        options?: never;
        head?: never;
        /**
         * Update User Role
         * @description Update a specific Postgres user's role within a cluster.
         */
        patch: operations["Postgres_users_update_role"];
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/users/{username}/credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get User Credentials
         * @description Get the connection credentials for a specific Postgres user within a cluster.
         */
        get: operations["Postgres_users_credentials"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/postgres/{postgres_cluster_id}/users/{username}/rotate_password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate User Password
         * @description Rotate a specific Postgres user's password within a cluster, optionally terminating the user's existing sessions.
         */
        post: operations["Postgres_users_rotate_password"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tokens/authenticate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Authenticate token header
         * @description Verify a token header without checking resource access.
         */
        post: operations["Tokens_authenticate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tokens/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Authorize token for resource access
         * @description Verify a token header and validate it against a requested access scope.
         */
        post: operations["Tokens_authorize"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tokens/current": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Current Token Information
         * @description Get information about the current macaroon token(s), including organizations, apps, user identity hashes, and machine restrictions
         */
        get: operations["CurrentToken_show"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tokens/kms": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a Petsem token for accessing KMS
         * @description This site hosts documentation generated from the Fly.io Machines API OpenAPI specification. Visit our complete [Machines API docs](https://fly.io/docs/machines/api/apps-resource/) for details about using the Apps resource.
         */
        post: operations["Tokens_request_Kms"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tokens/oidc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request an OIDC token
         * @description Request an Open ID Connect token for your machine. Customize the audience claim with the `aud` parameter. This returns a JWT token. Learn more about [using OpenID Connect](/docs/reference/openid-connect/) on Fly.io.
         */
        post: operations["Tokens_request_OIDC"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        AcmeChallenge: {
            name?: string;
            target?: string;
        };
        App: {
            id?: string;
            internal_numeric_id?: number;
            machine_count?: number;
            name?: string;
            network?: string;
            network_cidr?: string;
            organization?: components["schemas"]["AppOrganizationInfo"];
            status?: string;
            volume_count?: number;
        };
        AppOrganizationInfo: {
            internal_numeric_id?: number;
            name?: string;
            slug?: string;
        };
        AppSecret: {
            created_at?: string;
            digest?: string;
            name?: string;
            updated_at?: string;
            value?: string;
        };
        AppSecrets: {
            secrets?: components["schemas"]["AppSecret"][];
        };
        AppSecretsUpdateRequest: {
            values?: {
                [key: string]: string;
            };
        };
        AppSecretsUpdateResp: {
            /** @description DEPRECATED */
            Version?: number;
            secrets?: components["schemas"]["AppSecret"][];
            version?: number;
        };
        AssignIPResponse: {
            created_at?: string;
            egress?: boolean;
            ip?: string;
            /** @description ip_pair is returned when "egress-pair" IP type is requested; in this case, ip is null. */
            ip_pair?: components["schemas"]["IPPair"];
            network?: components["schemas"]["IPAssignmentNetwork"];
            region?: string;
            service_name?: string;
            shared?: boolean;
        };
        CertificateCheckResponse: {
            acme_requested?: boolean;
            certificates?: components["schemas"]["CertificateEntry"][];
            configured?: boolean;
            dns_provider?: string;
            dns_records?: components["schemas"]["DNSRecords"];
            dns_requirements?: components["schemas"]["DNSRequirements"];
            hostname?: string;
            rate_limited_until?: string;
            status?: string;
            validation?: components["schemas"]["CertificateValidation"];
            validation_errors?: components["schemas"]["CertificateValidationError"][];
        };
        CertificateDetail: {
            acme_requested?: boolean;
            certificates?: components["schemas"]["CertificateEntry"][];
            configured?: boolean;
            dns_provider?: string;
            dns_requirements?: components["schemas"]["DNSRequirements"];
            hostname?: string;
            rate_limited_until?: string;
            status?: string;
            validation?: components["schemas"]["CertificateValidation"];
            validation_errors?: components["schemas"]["CertificateValidationError"][];
        };
        CertificateEntry: {
            created_at?: string;
            expires_at?: string;
            issued?: components["schemas"]["IssuedCertificate"][];
            issuer?: string;
            /** @enum {string} */
            source?: "custom" | "fly";
            /** @enum {string} */
            status?: "active" | "pending_ownership" | "pending_validation";
        };
        CertificateSummary: {
            acme_alpn_configured?: boolean;
            acme_dns_configured?: boolean;
            acme_http_configured?: boolean;
            acme_requested?: boolean;
            configured?: boolean;
            created_at?: string;
            dns_provider?: string;
            has_custom_certificate?: boolean;
            has_fly_certificate?: boolean;
            hostname?: string;
            ownership_txt_configured?: boolean;
            status?: string;
            updated_at?: string;
        };
        CertificateValidation: {
            alpn_configured?: boolean;
            dns_configured?: boolean;
            http_configured?: boolean;
            ownership_txt_configured?: boolean;
        };
        CertificateValidationError: {
            code?: string;
            message?: string;
            remediation?: string;
            timestamp?: string;
        };
        CheckStatus: {
            name?: string;
            output?: string;
            status?: string;
            updated_at?: string;
        };
        CreateAppDeployTokenRequest: {
            expiry?: string;
        };
        CreateAppDeployTokenResponse: {
            token?: string;
        };
        CreateAppRequest: {
            enable_subdomains?: boolean;
            /**
             * @description When set, makes a retry of this exact request safe: a
             *     second create with the same key and the same name (or no name) returns
             *     the app the first request created, instead of erroring on a false name
             *     conflict or creating a duplicate. A second create with the same key
             *     but a *different* name is rejected outright; it won't silently
             *     hand back the first app.
             */
            idempotency_key?: string;
            name?: string;
            network?: string;
            org_slug?: string;
        };
        CreateAppResponse: {
            created_at?: number;
            id?: string;
        };
        CreateLeaseRequest: {
            description?: string;
            /** @description seconds lease will be valid */
            ttl?: number;
        };
        CreateMachineRequest: {
            /** @description An object defining the Machine configuration */
            config?: components["schemas"]["fly.MachineConfig"];
            lease_ttl?: number;
            min_secrets_version?: number;
            /** @description Unique name for this Machine. If omitted, one is generated for you */
            name?: string;
            /** @description The target region. Omitting this param launches in the same region as your WireGuard peer connection (somewhere near you). */
            region?: string;
            skip_launch?: boolean;
            skip_secrets?: boolean;
            skip_service_registration?: boolean;
        };
        /** @description Optional parameters */
        CreateOIDCTokenRequest: {
            /** @example https://fly.io/org-slug */
            aud?: string;
            aws_principal_tags?: boolean;
        };
        CreateVolumeRequest: {
            /** @description enable scheduled automatic snapshots. Defaults to `true` */
            auto_backup_enabled?: boolean;
            compute?: components["schemas"]["fly.MachineGuest"];
            compute_image?: string;
            encrypted?: boolean;
            fstype?: string;
            name?: string;
            region?: string;
            require_unique_zone?: boolean;
            size_gb?: number;
            /** @description restore from snapshot */
            snapshot_id?: string;
            snapshot_retention?: number;
            /** @description fork from remote volume */
            source_volume_id?: string;
            unique_zone_app_wide?: boolean;
        };
        CurrentTokenResponse: {
            tokens?: components["schemas"]["main.tokenInfo"][];
        };
        DNSRecords: {
            a?: string[];
            aaaa?: string[];
            acme_challenge_cname?: string;
            cname?: string[];
            ownership_txt?: string;
            resolved_addresses?: string[];
            soa?: string;
        };
        DNSRequirements: {
            a?: string[];
            aaaa?: string[];
            acme_challenge?: components["schemas"]["AcmeChallenge"];
            cname?: string;
            ownership?: components["schemas"]["OwnershipVerification"];
        };
        DecryptSecretkeyRequest: {
            associated_data?: number[];
            ciphertext?: number[];
        };
        DecryptSecretkeyResponse: {
            plaintext?: number[];
        };
        DeleteAppSecretResponse: {
            /** @description DEPRECATED */
            Version?: number;
            version?: number;
        };
        DeleteSecretkeyResponse: {
            /** @description DEPRECATED */
            Version?: number;
            version?: number;
        };
        EncryptSecretkeyRequest: {
            associated_data?: number[];
            plaintext?: number[];
        };
        EncryptSecretkeyResponse: {
            ciphertext?: number[];
        };
        ErrorResponse: {
            /** @description Deprecated */
            details?: Record<string, never>;
            error?: string;
            status?: components["schemas"]["main.statusCode"];
        };
        ExtendVolumeRequest: {
            size_gb?: number;
        };
        ExtendVolumeResponse: {
            needs_restart?: boolean;
            volume?: components["schemas"]["Volume"];
        };
        IPAssignment: {
            created_at?: string;
            egress?: boolean;
            ip?: string;
            network?: components["schemas"]["IPAssignmentNetwork"];
            region?: string;
            service_name?: string;
            shared?: boolean;
        };
        /** @description The 6PN network a Flycast (private_v6) address belongs to. Null for all other IP types. */
        IPAssignmentNetwork: {
            /** @description Network name; empty for the organization's default network. */
            name?: string;
            org_slug?: string;
        };
        /**
         * @description Type of IP address to allocate. "egress-pair" allocates both v4 and v6 egress IP addresses (recommended when using egress IPs).
         * @enum {string}
         */
        IPAssignmentType: "v4" | "v6" | "shared_v4" | "private_v6" | "egress_v4" | "egress_v6" | "egress_pair";
        IPPair: {
            v4?: string;
            v6?: string;
        };
        ImageRef: {
            digest?: string;
            labels?: {
                [key: string]: string;
            };
            registry?: string;
            repository?: string;
            tag?: string;
        };
        IssuedCertificate: {
            certificate_authority?: string;
            expires_at?: string;
            /** @enum {string} */
            type?: "rsa" | "ecdsa";
        };
        Lease: {
            /** @description Description or reason for the Lease. */
            description?: string;
            /** @description ExpiresAt is the unix timestamp in UTC to denote when the Lease will no longer be valid. */
            expires_at?: number;
            /** @description Nonce is the unique ID autogenerated and associated with the Lease. */
            nonce?: string;
            /** @description Owner is the user identifier which acquired the Lease. */
            owner?: string;
            /** @description Machine version */
            version?: string;
        };
        ListAppsResponse: {
            apps?: components["schemas"]["App"][];
            total_apps?: number;
        };
        ListenSocket: {
            address?: string;
            proto?: string;
        };
        Machine: {
            checks?: components["schemas"]["CheckStatus"][];
            config?: components["schemas"]["fly.MachineConfig"];
            cordoned?: boolean;
            created_at?: string;
            events?: components["schemas"]["MachineEvent"][];
            host_features?: string[];
            /** @enum {string} */
            host_status?: "ok" | "unknown" | "unreachable";
            id?: string;
            image_ref?: components["schemas"]["ImageRef"];
            incomplete_config?: components["schemas"]["fly.MachineConfig"];
            /** @description InstanceID is unique for each version of the machine */
            instance_id?: string;
            lease?: components["schemas"]["StrippedLease"];
            name?: string;
            /** @description Nonce is only every returned on machine creation if a lease_duration was provided. */
            nonce?: string;
            /** @description PrivateIP is the internal 6PN address of the machine. */
            private_ip?: string;
            region?: string;
            state?: string;
            updated_at?: string;
        };
        MachineEvent: {
            id?: string;
            request?: Record<string, never>;
            source?: string;
            status?: string;
            timestamp?: number;
            type?: string;
        };
        MachineExecRequest: {
            /** @description Deprecated: use Command instead */
            cmd?: string;
            command?: string[];
            container?: string;
            /**
             * @description Machine runs the command in the machine's own namespace instead of in a
             *     container. It is mutually exclusive with Container.
             */
            machine?: boolean;
            stdin?: string;
            timeout?: number;
        };
        MachineOverviewConfig: {
            guest?: components["schemas"]["fly.MachineGuest"];
            image?: string;
            metadata?: {
                [key: string]: string;
            };
        };
        MachineVersion: {
            user_config?: components["schemas"]["fly.MachineConfig"];
            version?: string;
        };
        OrgMachine: {
            app_name?: string;
            config?: components["schemas"]["MachineOverviewConfig"];
            created_at?: string;
            id?: string;
            name?: string;
            private_ip?: string;
            region?: string;
            state?: string;
            updated_at?: string;
            version?: string;
        };
        OrgMachinesResponse: {
            error_regions?: string[];
            last_machine_id?: string;
            last_updated_at?: string;
            machines?: components["schemas"]["OrgMachine"][];
            next_cursor?: string;
        };
        OrgVolume: {
            app_name?: string;
            attached_alloc_id?: string;
            attached_machine_id?: string;
            auto_backup_enabled?: boolean;
            block_size?: number;
            blocks?: number;
            blocks_avail?: number;
            blocks_free?: number;
            bytes_total?: number;
            bytes_used?: number;
            created_at?: string;
            encrypted?: boolean;
            fstype?: string;
            host_features?: string[];
            /** @enum {string} */
            host_status?: "ok" | "unknown" | "unreachable";
            id?: string;
            name?: string;
            region?: string;
            required_host_features?: string[];
            size_gb?: number;
            snapshot_retention?: number;
            state?: string;
            /** @enum {string} */
            type?: "local" | "cache";
            updated_at?: string;
            zone?: string;
        };
        OrgVolumesResponse: {
            last_updated_at?: string;
            last_volume_id?: string;
            next_cursor?: string;
            volumes?: components["schemas"]["OrgVolume"][];
        };
        OrganizationRef: {
            /** @description Organization name. */
            name?: string;
            /** @description Organization slug. */
            slug?: string;
        };
        OwnershipVerification: {
            app_value?: string;
            name?: string;
            org_value?: string;
        };
        PostgresActiveQuery: {
            /** @description Application connected to the backend. */
            application_name?: string;
            /** @description Client address. */
            client?: string;
            /** @description Database name. */
            database?: string;
            /** @description Query duration in seconds. */
            duration_seconds?: number;
            /** @description Process ID of the backend running the query. */
            pid?: number;
            /** @description Full query text. */
            query?: string;
            /** @description Current backend state. */
            state?: string;
            /** @description Time spent in the current state, in seconds. */
            state_duration_seconds?: number;
            /** @description User running the query. */
            user?: string;
            /** @description Event the backend is waiting for. */
            wait_event?: string;
            /** @description Type of event the backend is waiting for. */
            wait_event_type?: string;
        };
        PostgresAttachedApp: {
            /** @description Attached Fly app name. */
            name?: string;
        };
        PostgresAttachment: {
            /** @description Attached Fly app name. */
            app_name?: string;
            /** @description RFC 3339 timestamp when the attachment was created. */
            attached_at?: string;
            /** @description Cluster ID the app is attached to. */
            postgres_cluster_id?: string;
        };
        PostgresBackup: {
            /** @description RFC 3339 stop timestamp. */
            finished_at?: string;
            /** @description Backup ID. */
            id?: string;
            /** @description Backup size in bytes. */
            size_bytes?: number;
            /** @description RFC 3339 start timestamp. */
            started_at?: string;
            /**
             * @description Backup status.
             * @example completed
             */
            status?: string;
            /**
             * @description Backup type.
             * @enum {string}
             */
            type?: "full" | "incr" | "diff";
        };
        PostgresCluster: {
            /** @description Apps attached to the cluster. */
            attached_apps?: components["schemas"]["PostgresAttachedApp"][];
            /**
             * @description CPU class.
             * @example shared
             * @enum {string}
             */
            cpu_kind?: "shared" | "performance";
            /**
             * @description vCPUs per node.
             * @example 2
             */
            cpus?: number;
            /**
             * Format: date-time
             * @description RFC 3339 creation timestamp.
             */
            created_at?: string;
            /**
             * @description Disk size in gigabytes, for one replica.
             * @example 10
             */
            disk_size_gb?: number;
            /** @description Connection endpoints. Populated once the cluster is ready. */
            endpoints?: components["schemas"]["PostgresClusterEndpoints"];
            /** @description Cluster ID. */
            id?: string;
            /**
             * @description Memory per node in megabytes.
             * @example 1024
             */
            memory_mb?: number;
            /** @description Cluster name. */
            name?: string;
            organization?: components["schemas"]["OrganizationRef"];
            /**
             * @description Postgres major version.
             * @example 17
             * @enum {string}
             */
            pg_major_version?: "16" | "17";
            /**
             * @description Plan slug.
             * @example basic
             * @enum {string}
             */
            plan?: "basic" | "starter" | "launch" | "scale" | "Performance";
            /** @description Whether PostGIS support is enabled. */
            postgis_enabled?: boolean;
            /**
             * @description Fly region code.
             * @example iad
             */
            region?: string;
            /**
             * @description Number of replicas.
             * @example 1
             */
            replicas?: number;
            /**
             * @description Current lifecycle status.
             * @example ready
             * @enum {string}
             */
            status?: "creating" | "initializing" | "ready" | "deleting" | "deleted" | "failed";
            /**
             * @description Storage provisioned, summed across the cluster's volumes and measured hourly.
             *     Null until first measured.
             * @example 10737418240
             */
            storage_provisioned_bytes?: number | null;
            /**
             * @description Storage used, summed across the cluster's volumes and measured hourly. Null
             *     until first measured.
             * @example 5368709120
             */
            storage_used_bytes?: number | null;
        };
        PostgresClusterEndpoints: {
            /** @description Endpoints for connecting to the primary node. */
            primary?: components["schemas"]["PostgresNodeEndpoints"];
        };
        PostgresClusterSummary: {
            /** @description Apps attached to the cluster. */
            attached_apps?: components["schemas"]["PostgresAttachedApp"][];
            /**
             * Format: date-time
             * @description RFC 3339 creation timestamp.
             */
            created_at?: string;
            /** @description RFC 3339 deletion timestamp; present for deleted clusters. */
            deleted_at?: string;
            /** @description Cluster ID. */
            id?: string;
            /** @description Cluster name. */
            name?: string;
            /**
             * @description Plan slug.
             * @example basic
             * @enum {string}
             */
            plan?: "basic" | "starter" | "launch" | "scale" | "Performance";
            /**
             * @description Fly region code.
             * @example iad
             */
            region?: string;
            /**
             * @description Current lifecycle status.
             * @example ready
             * @enum {string}
             */
            status?: "creating" | "initializing" | "ready" | "deleting" | "deleted" | "failed";
        };
        PostgresDatabase: {
            /** @description Database name. */
            name?: string;
        };
        PostgresEndpoint: {
            /** @description Hostname to connect to. */
            host?: string;
            /** @description TCP port. */
            port?: number;
        };
        PostgresErrorResponse: {
            /** @description Human-readable error message. */
            error?: string;
        };
        PostgresExtension: {
            /** @description Default version installed when enabled. */
            default_version?: string;
            /** @description Human-readable description. */
            description?: string;
            /** @description Installation details, or null when the extension is not installed. */
            installed?: {
                /**
                 * @description Schema the extension is installed into.
                 * @example public
                 */
                schema?: string;
                /**
                 * @description Installed version.
                 * @example 1.0
                 */
                version?: string;
            } | null;
            /**
             * @description Extension name.
             * @example citext
             */
            name?: string;
            /** @description Whether this is a system extension that cannot be disabled. */
            system?: boolean;
        };
        PostgresInstalledExtension: {
            /**
             * @description Schema the extension is installed into.
             * @example public
             */
            schema?: string;
            /**
             * @description Installed version.
             * @example 1.0
             */
            version?: string;
        };
        PostgresNodeEndpoints: {
            /** @description Unpooled connection to the cluster node. */
            direct?: components["schemas"]["PostgresEndpoint"];
            /** @description Pooled connection to the cluster node (through PgBouncer). */
            pooler?: components["schemas"]["PostgresEndpoint"];
        };
        PostgresSlowQuery: {
            /** @description Cumulative number of executions. */
            calls?: number;
            /** @description Database name. */
            database?: string;
            /** @description Maximum execution time in seconds. */
            max_exec_time_seconds?: number;
            /** @description Mean execution time in seconds. */
            mean_exec_time_seconds?: number;
            /** @description Full query pattern. */
            query?: string;
            /** @description Query identifier. */
            query_id?: string;
            /** @description Cumulative total execution time in seconds. */
            total_exec_time_seconds?: number;
            /** @description User running the query. */
            user?: string;
        };
        PostgresUser: {
            /**
             * @description User role.
             * @enum {string}
             */
            role?: "schema_admin" | "writer" | "reader";
            /** @description User name. */
            username?: string;
        };
        PostgresUserCredentials: {
            /** @description User password. */
            password?: string;
            /** @description User name. */
            username?: string;
        };
        ProcessStat: {
            command?: string;
            cpu?: number;
            directory?: string;
            listen_sockets?: components["schemas"]["ListenSocket"][];
            pid?: number;
            rss?: number;
            rtime?: number;
            stime?: number;
        };
        SecretKey: {
            created_at?: string;
            name?: string;
            public_key?: number[];
            type?: string;
            updated_at?: string;
        };
        SecretKeys: {
            secret_keys?: components["schemas"]["SecretKey"][];
        };
        SetAppSecretRequest: {
            value?: string;
        };
        SetAppSecretResponse: {
            /** @description DEPRECATED */
            Version?: number;
            created_at?: string;
            digest?: string;
            name?: string;
            updated_at?: string;
            value?: string;
            version?: number;
        };
        SetSecretkeyRequest: {
            type?: string;
            value?: number[];
        };
        SetSecretkeyResponse: {
            /** @description DEPRECATED */
            Version?: number;
            created_at?: string;
            name?: string;
            public_key?: number[];
            type?: string;
            updated_at?: string;
            version?: number;
        };
        SignSecretkeyRequest: {
            plaintext?: number[];
        };
        SignSecretkeyResponse: {
            signature?: number[];
        };
        SignalRequest: {
            /** @enum {string} */
            signal?: "SIGABRT" | "SIGALRM" | "SIGFPE" | "SIGHUP" | "SIGILL" | "SIGINT" | "SIGKILL" | "SIGPIPE" | "SIGQUIT" | "SIGSEGV" | "SIGTERM" | "SIGTRAP" | "SIGUSR1" | "SIGUSR2";
        };
        StopRequest: {
            /**
             * @example SIGTERM
             * @enum {string}
             */
            signal?: "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGKILL" | "SIGUSR1" | "SIGUSR2" | "SIGTERM";
            /** @example 1s */
            timeout?: string;
        };
        StrippedLease: {
            description?: string;
            expires_at?: number;
            owner?: string;
        };
        UpdateMachineRequest: {
            /** @description An object defining the Machine configuration */
            config?: components["schemas"]["fly.MachineConfig"];
            current_version?: string;
            lease_ttl?: number;
            min_secrets_version?: number;
            /** @description Unique name for this Machine. If omitted, one is generated for you */
            name?: string;
            /** @description The target region. Omitting this param launches in the same region as your WireGuard peer connection (somewhere near you). */
            region?: string;
            skip_launch?: boolean;
            skip_secrets?: boolean;
            skip_service_registration?: boolean;
        };
        UpdateVolumeRequest: {
            auto_backup_enabled?: boolean;
            snapshot_retention?: number;
        };
        VerifySecretkeyRequest: {
            plaintext?: number[];
            signature?: number[];
        };
        Volume: {
            attached_alloc_id?: string;
            attached_machine_id?: string;
            auto_backup_enabled?: boolean;
            block_size?: number;
            blocks?: number;
            blocks_avail?: number;
            blocks_free?: number;
            bytes_total?: number;
            bytes_used?: number;
            created_at?: string;
            encrypted?: boolean;
            fstype?: string;
            host_features?: string[];
            /** @enum {string} */
            host_status?: "ok" | "unknown" | "unreachable";
            id?: string;
            name?: string;
            region?: string;
            required_host_features?: string[];
            size_gb?: number;
            snapshot_retention?: number;
            state?: string;
            /** @enum {string} */
            type?: "local" | "cache";
            zone?: string;
        };
        VolumeSnapshot: {
            created_at?: string;
            digest?: string;
            id?: string;
            retention_days?: number;
            size?: number;
            status?: string;
            volume_size?: number;
        };
        WaitMachineResponse: {
            event_id?: string;
            ok?: boolean;
            state?: string;
            version?: string;
        };
        assignIPRequest: {
            network?: string;
            org_slug?: string;
            region?: string;
            service_name?: string;
            type?: components["schemas"]["IPAssignmentType"];
        };
        authenticateTokenRequest: {
            header?: string;
        };
        authorizeResponse: {
            access?: components["schemas"]["flyio.Access"];
            verified_token?: components["schemas"]["root.VerifiedToken"];
        };
        authorizeTokenRequest: {
            access?: components["schemas"]["main.TokenAccess"];
            header?: string;
        };
        createAcmeCertificateRequest: {
            hostname?: string;
        };
        createCustomCertificateRequest: {
            fullchain?: string;
            hostname?: string;
            private_key?: string;
        };
        createPostgresAttachmentRequest: {
            /** @description Name of the Fly app to attach. */
            app_name: string;
        };
        createPostgresAttachmentResponse: {
            data?: components["schemas"]["PostgresAttachment"];
        };
        createPostgresBackupRequest: {
            /**
             * @description Backup type.
             * @example full
             * @enum {string}
             */
            type: "full" | "incr" | "diff";
        };
        createPostgresClusterRequest: {
            /**
             * @description Disk size in gigabytes.
             * @example 10
             */
            disk_size_gb?: number;
            /** @description Name for the cluster. A name is generated when omitted. */
            name?: string;
            /**
             * @description Slug of the organization that will own the cluster, or "personal" for the caller's personal organization.
             * @example my-org
             */
            org_slug: string;
            /**
             * @description Postgres major version.
             * @example 17
             * @enum {string}
             */
            pg_major_version?: "16" | "17";
            /**
             * @description Plan slug selecting CPU, memory, and disk sizing. Matched case-insensitively.
             * @example basic
             * @enum {string}
             */
            plan: "basic" | "starter" | "launch" | "scale" | "Performance";
            /**
             * @description Connection pooler mode.
             * @example transaction
             * @enum {string}
             */
            pool_mode?: "session" | "transaction";
            /** @description Enable PostGIS support, required to later enable PostGIS extensions. */
            postgis_enabled?: boolean;
            /**
             * @description Fly region code where the cluster's primary runs.
             * @example iad
             */
            region: string;
        };
        createPostgresDatabaseRequest: {
            /**
             * @description Name of the database to create. Must start and end with an alphanumeric
             *     character and may contain hyphens and underscores, up to 63 characters.
             * @example customer_data
             */
            name: string;
        };
        createPostgresUserRequest: {
            /**
             * @description Role to grant the user.
             * @example writer
             * @enum {string}
             */
            role: "schema_admin" | "writer" | "reader";
            /**
             * @description Name for the new user. Must start and end with a lowercase alphanumeric
             *     character and may contain hyphens and underscores, up to 63 characters.
             * @example app_user
             */
            username: string;
        };
        createPostgresUserResponse: {
            data?: components["schemas"]["PostgresUser"];
        };
        destroyCustomCertificateResponse: {
            acme_requested?: boolean;
            certificates?: components["schemas"]["CertificateEntry"][];
            configured?: boolean;
            dns_provider?: string;
            dns_requirements?: components["schemas"]["DNSRequirements"];
            hostname?: string;
            rate_limited_until?: string;
            status?: string;
            validation?: components["schemas"]["CertificateValidation"];
            validation_errors?: components["schemas"]["CertificateValidationError"][];
            warning?: string;
        };
        enablePostgresExtensionRequest: {
            /** @description Create the schema first if it does not exist. */
            create_schema?: boolean;
            /**
             * @description Extension to enable.
             * @example citext
             */
            name: string;
            /** @description Schema to install the extension into. Defaults to the database's default schema. */
            schema?: string;
        };
        "fly.ContainerConfig": {
            /** @description CmdOverride is used to override the default command of the image. */
            cmd?: string[];
            /**
             * @description DependsOn can be used to define dependencies between containers. The container will only be
             *     started after all of its dependent conditions have been satisfied.
             */
            depends_on?: components["schemas"]["fly.ContainerDependency"][];
            /** @description EntrypointOverride is used to override the default entrypoint of the image. */
            entrypoint?: string[];
            /** @description ExtraEnv is used to add additional environment variables to the container. */
            env?: {
                [key: string]: string;
            };
            /** @description EnvFrom can be provided to set environment variables from machine fields. */
            env_from?: components["schemas"]["fly.EnvFrom"][];
            /**
             * @description Image Config overrides - these fields are used to override the image configuration.
             *     If not provided, the image configuration will be used.
             *     ExecOverride is used to override the default command of the image.
             */
            exec?: string[];
            /** @description Files are files that will be written to the container file system. */
            files?: components["schemas"]["fly.File"][];
            /** @description Healthchecks determine the health of your containers. Healthchecks can use HTTP, TCP or an Exec command. */
            healthchecks?: components["schemas"]["fly.ContainerHealthcheck"][];
            /** @description Image is the docker image to run. */
            image?: string;
            /** @description Name is used to identify the container in the machine. */
            name?: string;
            /** @description Restart is used to define the restart policy for the container. */
            restart?: components["schemas"]["fly.MachineRestart"];
            /**
             * @description Secrets can be provided at the process level to explicitly indicate which secrets should be
             *     used for the process. If not provided, the secrets provided at the machine level will be used.
             */
            secrets?: components["schemas"]["fly.MachineSecret"][];
            /** @description Stop is used to define the signal and timeout for stopping the container. */
            stop?: components["schemas"]["fly.StopConfig"];
            /** @description UserOverride is used to override the default user of the image. */
            user?: string;
        };
        "fly.ContainerDependency": {
            condition?: components["schemas"]["fly.ContainerDependencyCondition"];
            name?: string;
        };
        /** @enum {string} */
        "fly.ContainerDependencyCondition": "exited_successfully" | "healthy" | "started";
        "fly.ContainerHealthcheck": {
            exec?: components["schemas"]["fly.ExecHealthcheck"];
            /** @description The number of times the check must fail before considering the container unhealthy. */
            failure_threshold?: number;
            /** @description The time in seconds to wait after a container starts before checking its health. */
            grace_period?: number;
            http?: components["schemas"]["fly.HTTPHealthcheck"];
            /** @description The time in seconds between executing the defined check. */
            interval?: number;
            /** @description Kind of healthcheck (readiness, liveness) */
            kind?: components["schemas"]["fly.ContainerHealthcheckKind"];
            /** @description The name of the check. Must be unique within the container. */
            name?: string;
            /** @description The number of times the check must succeeed before considering the container healthy. */
            success_threshold?: number;
            tcp?: components["schemas"]["fly.TCPHealthcheck"];
            /** @description The time in seconds to wait for the check to complete. */
            timeout?: number;
            /** @description Unhealthy policy that determines what action to take if a container is deemed unhealthy */
            unhealthy?: components["schemas"]["fly.UnhealthyPolicy"];
        };
        /** @enum {string} */
        "fly.ContainerHealthcheckKind": "readiness" | "liveness";
        /** @enum {string} */
        "fly.ContainerHealthcheckScheme": "http" | "https";
        "fly.DNSConfig": {
            dns_forward_rules?: components["schemas"]["fly.dnsForwardRule"][];
            hostname?: string;
            hostname_fqdn?: string;
            nameservers?: string[];
            options?: components["schemas"]["fly.dnsOption"][];
            searches?: string[];
            skip_registration?: boolean;
        };
        /** @description EnvVar defines an environment variable to be populated from a machine field, env_var */
        "fly.EnvFrom": {
            /**
             * @description EnvVar is required and is the name of the environment variable that will be set from the
             *     secret. It must be a valid environment variable name.
             */
            env_var?: string;
            /**
             * @description FieldRef selects a field of the Machine: supports id, version, app_name, private_ip, region, image.
             * @enum {string}
             */
            field_ref?: "id" | "version" | "app_name" | "private_ip" | "region" | "image";
        };
        "fly.ExecHealthcheck": {
            /** @description The command to run to check the health of the container (e.g. ["cat", "/tmp/healthy"]) */
            command?: string[];
        };
        /** @description A file that will be written to the Machine. One of RawValue or SecretName must be set. */
        "fly.File": {
            /**
             * @description GuestPath is the path on the machine where the file will be written and must be an absolute path.
             *     For example: /full/path/to/file.json
             */
            guest_path?: string;
            /** @description The name of an image to use the OCI image config as the file contents. */
            image_config?: string;
            /** @description Mode bits used to set permissions on this file as accepted by chmod(2). */
            mode?: number;
            /** @description The base64 encoded string of the file contents. */
            raw_value?: string;
            /** @description The name of the secret that contains the base64 encoded file contents. */
            secret_name?: string;
        };
        "fly.HTTPHealthcheck": {
            /** @description Additional headers to send with the request */
            headers?: components["schemas"]["fly.MachineHTTPHeader"][];
            /** @description The HTTP method to use to when making the request */
            method?: string;
            /** @description The path to send the request to */
            path?: string;
            /** @description The port to connect to, often the same as internal_port */
            port?: number;
            /** @description Whether to use http or https */
            scheme?: components["schemas"]["fly.ContainerHealthcheckScheme"];
            /** @description If the protocol is https, the hostname to use for TLS certificate validation */
            tls_server_name?: string;
            /** @description If the protocol is https, whether or not to verify the TLS certificate */
            tls_skip_verify?: boolean;
        };
        "fly.HTTPOptions": {
            compress?: boolean;
            h2_backend?: boolean;
            headers_read_timeout?: number;
            idle_timeout?: number;
            replay_cache?: components["schemas"]["fly.ReplayCache"][];
            response?: components["schemas"]["fly.HTTPResponseOptions"];
        };
        "fly.HTTPResponseOptions": {
            headers?: {
                [key: string]: Record<string, never>;
            };
            pristine?: boolean;
        };
        "fly.MachineCacheDrive": {
            size_mb?: number;
        };
        "fly.MachineCheck": {
            /**
             * @description The time to wait after a VM starts before checking its health
             * @example 1s
             */
            grace_period?: string;
            headers?: components["schemas"]["fly.MachineHTTPHeader"][];
            /**
             * @description The time between connectivity checks
             * @example 15s
             */
            interval?: string;
            /**
             * @description Kind of the check (informational, readiness)
             * @enum {string}
             */
            kind?: "informational" | "readiness";
            /** @description For http checks, the HTTP method to use to when making the request */
            method?: string;
            /** @description For http checks, the path to send the request to */
            path?: string;
            /** @description The port to connect to, often the same as internal_port */
            port?: number;
            /** @description For http checks, whether to use http or https */
            protocol?: string;
            /**
             * @description The maximum time a connection can take before being reported as failing its health check
             * @example 2s
             */
            timeout?: string;
            /** @description If the protocol is https, the hostname to use for TLS certificate validation */
            tls_server_name?: string;
            /** @description For http checks with https protocol, whether or not to verify the TLS certificate */
            tls_skip_verify?: boolean;
            /** @description tcp or http */
            type?: string;
        };
        "fly.MachineConfig": {
            /** @description Optional boolean telling the Machine to destroy itself once it’s complete (default false) */
            auto_destroy?: boolean;
            cache_drive?: components["schemas"]["fly.MachineCacheDrive"];
            /** @description An optional object that defines one or more named top-level checks. The key for each check is the check name. */
            checks?: {
                [key: string]: components["schemas"]["fly.MachineCheck"];
            };
            /**
             * @description Containers are a list of containers that will run in the machine. Currently restricted to
             *     only specific organizations.
             */
            containers?: components["schemas"]["fly.ContainerConfig"][];
            /** @description Deprecated: use Service.Autostart instead */
            disable_machine_autostart?: boolean;
            dns?: components["schemas"]["fly.DNSConfig"];
            /** @description An object filled with key/value pairs to be set as environment variables */
            env?: {
                [key: string]: string;
            };
            files?: components["schemas"]["fly.File"][];
            guest?: components["schemas"]["fly.MachineGuest"];
            /** @description The docker image to run */
            image?: string;
            init?: components["schemas"]["fly.MachineInit"];
            metadata?: {
                [key: string]: string;
            };
            metrics?: components["schemas"]["fly.MachineMetrics"];
            mounts?: components["schemas"]["fly.MachineMount"][];
            processes?: components["schemas"]["fly.MachineProcess"][];
            restart?: components["schemas"]["fly.MachineRestart"];
            rootfs?: components["schemas"]["fly.MachineRootfs"];
            schedule?: string;
            services?: components["schemas"]["fly.MachineService"][];
            /** @description Deprecated: use Guest instead */
            size?: string;
            spot?: components["schemas"]["fly.MachineSpot"];
            /**
             * @description Standbys enable a machine to be a standby for another. In the event of a hardware failure,
             *     the standby machine will be started.
             */
            standbys?: string[];
            statics?: components["schemas"]["fly.Static"][];
            stop_config?: components["schemas"]["fly.StopConfig"];
        };
        "fly.MachineGuest": {
            cpu_kind?: string;
            cpus?: number;
            gpu_kind?: string;
            gpus?: number;
            host_dedication_id?: string;
            kernel_args?: string[];
            max_memory_mb?: number;
            memory_mb?: number;
            /**
             * @description Deprecated: use MachineConfig.Rootfs instead
             * @enum {string}
             */
            persist_rootfs?: "never" | "always" | "restart";
            required_host_features?: string[];
        };
        /** @description For http checks, an array of objects with string field Name and array of strings field Values. The key/value pairs specify header and header values that will get passed with the check call. */
        "fly.MachineHTTPHeader": {
            /** @description The header name */
            name?: string;
            /** @description The header value */
            values?: string[];
        };
        "fly.MachineInit": {
            cmd?: string[];
            entrypoint?: string[];
            exec?: string[];
            kernel_args?: string[];
            swap_size_mb?: number;
            tty?: boolean;
        };
        "fly.MachineMetrics": {
            https?: boolean;
            path?: string;
            port?: number;
        };
        "fly.MachineMount": {
            add_size_gb?: number;
            /**
             * @description AddSizePercent grows by a percentage of the current size, rounded up to GiB.
             *     It is mutually exclusive with AddSizeGb.
             */
            add_size_percent?: number;
            encrypted?: boolean;
            extend_threshold_percent?: number;
            /** @description MinAddSizeGb is the minimum proportional growth in GiB (default 1). */
            min_add_size_gb?: number;
            name?: string;
            path?: string;
            size_gb?: number;
            size_gb_limit?: number;
            volume?: string;
        };
        "fly.MachinePort": {
            end_port?: number;
            force_https?: boolean;
            handlers?: string[];
            http_options?: components["schemas"]["fly.HTTPOptions"];
            port?: number;
            proxy_proto_options?: components["schemas"]["fly.ProxyProtoOptions"];
            start_port?: number;
            tls_options?: components["schemas"]["fly.TLSOptions"];
        };
        "fly.MachineProcess": {
            cmd?: string[];
            entrypoint?: string[];
            env?: {
                [key: string]: string;
            };
            /** @description EnvFrom can be provided to set environment variables from machine fields. */
            env_from?: components["schemas"]["fly.EnvFrom"][];
            exec?: string[];
            /**
             * @description IgnoreAppSecrets can be set to true to ignore the secrets for the App the Machine belongs to
             *     and only use the secrets provided at the process level. The default/legacy behavior is to use
             *     the secrets provided at the App level.
             */
            ignore_app_secrets?: boolean;
            /**
             * @description Secrets can be provided at the process level to explicitly indicate which secrets should be
             *     used for the process. If not provided, the secrets provided at the machine level will be used.
             */
            secrets?: components["schemas"]["fly.MachineSecret"][];
            user?: string;
        };
        /** @description The Machine restart policy defines whether and how flyd restarts a Machine after its main process exits. See https://fly.io/docs/machines/guides-examples/machine-restart-policy/. */
        "fly.MachineRestart": {
            /** @description When policy is on-failure, the maximum number of times to attempt to restart the Machine before letting it stop. */
            max_retries?: number;
            /**
             * @description * no - Never try to restart a Machine automatically when its main process exits, whether that’s on purpose or on a crash.
             *     * always - Always restart a Machine automatically and never let it enter a stopped state, even when the main process exits cleanly.
             *     * on-failure - Try up to MaxRetries times to automatically restart the Machine if it exits with a non-zero exit code. Default when no explicit policy is set, and for Machines with schedules.
             * @enum {string}
             */
            policy?: "no" | "always" | "on-failure";
        };
        "fly.MachineRootfs": {
            /** @enum {string} */
            persist?: "never" | "always" | "restart";
            size_gb?: number;
        };
        /** @description A Secret needing to be set in the environment of the Machine. env_var is required */
        "fly.MachineSecret": {
            /**
             * @description EnvVar is required and is the name of the environment variable that will be set from the
             *     secret. It must be a valid environment variable name.
             */
            env_var?: string;
            /**
             * @description Name is optional and when provided is used to reference a secret name where the EnvVar is
             *     different from what was set as the secret name.
             */
            name?: string;
        };
        "fly.MachineService": {
            autostart?: boolean;
            /**
             * @description Accepts a string (new format) or a boolean (old format). For backward compatibility with older clients, the API continues to use booleans for "off" and "stop" in responses.
             *     * "off" or false - Do not autostop the Machine.
             *     * "stop" or true - Automatically stop the Machine.
             *     * "suspend" - Automatically suspend the Machine, falling back to a full stop if this is not possible.
             * @enum {string}
             */
            autostop?: "off" | "stop" | "suspend";
            /** @description An optional list of service checks */
            checks?: components["schemas"]["fly.MachineServiceCheck"][];
            concurrency?: components["schemas"]["fly.MachineServiceConcurrency"];
            force_instance_description?: string;
            force_instance_key?: string;
            internal_port?: number;
            min_machines_running?: number;
            ports?: components["schemas"]["fly.MachinePort"][];
            protocol?: string;
        };
        "fly.MachineServiceCheck": {
            /**
             * @description The time to wait after a VM starts before checking its health
             * @example 1s
             */
            grace_period?: string;
            headers?: components["schemas"]["fly.MachineHTTPHeader"][];
            /**
             * @description The time between connectivity checks
             * @example 15s
             */
            interval?: string;
            /** @description For http checks, the HTTP method to use to when making the request */
            method?: string;
            /** @description For http checks, the path to send the request to */
            path?: string;
            /** @description The port to connect to, often the same as internal_port */
            port?: number;
            /** @description For http checks, whether to use http or https */
            protocol?: string;
            /**
             * @description The maximum time a connection can take before being reported as failing its health check
             * @example 2s
             */
            timeout?: string;
            /** @description If the protocol is https, the hostname to use for TLS certificate validation */
            tls_server_name?: string;
            /** @description For http checks with https protocol, whether or not to verify the TLS certificate */
            tls_skip_verify?: boolean;
            /** @description tcp or http */
            type?: string;
        };
        "fly.MachineServiceConcurrency": {
            hard_limit?: number;
            soft_limit?: number;
            type?: string;
        };
        "fly.MachineSpot": {
            /** @description MaxPriceFraction is the maximum fraction of the full Machine price you will pay for this Machine. Range: (0, 1.0] */
            max_price_fraction?: number;
        };
        "fly.ProxyProtoOptions": {
            version?: string;
        };
        "fly.ReplayCache": {
            allow_bypass?: boolean;
            /** @description Name of the cookie or header to key the cache on */
            name?: string;
            path_prefix?: string;
            ttl_seconds?: number;
            /**
             * @description Currently either "cookie" or "header"
             * @enum {string}
             */
            type?: "cookie" | "header";
        };
        "fly.Static": {
            guest_path: string;
            index_document?: string;
            tigris_bucket?: string;
            url_prefix: string;
        };
        "fly.StopConfig": {
            /** @enum {string} */
            signal?: "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGKILL" | "SIGUSR1" | "SIGUSR2" | "SIGTERM";
            /** @example 10s */
            timeout?: string;
        };
        "fly.TCPHealthcheck": {
            /** @description The port to connect to, often the same as internal_port */
            port?: number;
        };
        "fly.TLSOptions": {
            alpn?: string[];
            default_self_signed?: boolean;
            versions?: string[];
        };
        /** @enum {string} */
        "fly.UnhealthyPolicy": "stop";
        "fly.dnsForwardRule": {
            addr?: string;
            basename?: string;
        };
        "fly.dnsOption": {
            name?: string;
            value?: string;
        };
        "flydv1.ExecResponse": {
            exit_code?: number;
            exit_signal?: number;
            stderr?: string;
            stdout?: string;
        };
        "flyio.Access": {
            action?: components["schemas"]["resset.Action"];
            app_feature?: string;
            appid?: number;
            cluster?: string;
            command?: string[];
            feature?: string;
            machine?: string;
            machine_feature?: string;
            mutation?: string;
            orgid?: number;
            sourceApp?: string;
            sourceMachine?: string;
            sourceOrganization?: string;
            storage_object?: string;
            volume?: string;
        };
        forkPostgresClusterRequest: {
            /** @description Name for the forked cluster. Defaults to the source name with a -fork suffix. */
            name?: string;
        };
        getPostgresUserCredentialsResponse: {
            data?: components["schemas"]["PostgresUserCredentials"];
        };
        listCertificatesResponse: {
            certificates?: components["schemas"]["CertificateSummary"][];
            next_cursor?: string;
            total_count?: number;
        };
        listIPAssignmentsResponse: {
            ips?: components["schemas"]["IPAssignment"][];
        };
        listPostgresActiveQueriesResponse: {
            data?: components["schemas"]["PostgresActiveQuery"][];
        };
        listPostgresBackupsResponse: {
            data?: components["schemas"]["PostgresBackup"][];
        };
        listPostgresClustersResponse: {
            data?: components["schemas"]["PostgresClusterSummary"][];
        };
        listPostgresDatabasesResponse: {
            data?: components["schemas"]["PostgresDatabase"][];
        };
        listPostgresExtensionsResponse: {
            data?: components["schemas"]["PostgresExtension"][];
        };
        listPostgresSlowQueriesResponse: {
            data?: components["schemas"]["PostgresSlowQuery"][];
        };
        listPostgresUsersResponse: {
            data?: components["schemas"]["PostgresUser"][];
        };
        "macaroon.CaveatSet": {
            caveats?: Record<string, never>[];
        };
        "macaroon.Nonce": {
            kid?: number[];
            proof?: boolean;
            rnd?: number[];
        };
        "main.TokenAccess": {
            /**
             * @description Action is the action being taken on the specified resource. This is the
             *     combination of individual action characters (e.g "rw")
             *       - r: read
             *       - w: write
             *       - c: create
             *       - d: delete
             *       - C: control
             */
            action?: components["schemas"]["resset.Action"];
            /**
             * @description AppFeature is a named set of functionality associated with the app. If
             *     this is specified, the AppName field must be set.
             *       - images: images in the fly.io registry
             */
            app_feature?: string;
            /** @description AppName is the name of the app being accessed. */
            app_name?: string;
            /**
             * @description Command is the command being executed on a machine. If this is specified,
             *     the Machine must be set.
             */
            command?: string[];
            /**
             * @description MachineFeature is a named set of functionality associated with the
             *     machine. If this is specified, the Machine field must be set.
             *       - metadata: machine metadata service
             *       - oidc: OIDC tokens
             *       - kmstoken: Petsem tokens for KMS access
             */
            machine_feature?: string;
            /** @description MachineID is the ID of the machine being accessed (e.g. 7811701f564258). */
            machine_id?: string;
            /** @description Mutation is the GraphQL mutation being performed. */
            mutation?: string;
            /**
             * @description OrgFeature is a named set of functionality associated with the
             *     organization. If this is specified, the OrgSlug field must be set.
             *       - wg: WireGuard peers
             *       - builder: remote builders
             *       - addon: addons
             *       - membership: organization membership
             *       - billing: billing
             *       - litefs-cloud: LiteFS Cloud
             *       - authentication: authentication settings
             */
            org_feature?: string;
            /** @description OrgSlug is the slug of the organization being accessed. */
            org_slug?: string;
            /** @description SourceMachine is the machine ID of the actor attempting access. */
            source_machine?: string;
            /**
             * @description StorageObject is the storage object being accessed. If this is specified,
             *     the OrgSlug must be set.
             */
            storage_object?: string;
            /**
             * @description VolumeID is the encoded ID of the volume being accessed (e.g.
             *     vol_r1p6pln1k9m9j7zr).
             */
            volume_id?: string;
        };
        "main.getPlacementsRequest": {
            /** @description Resource requirements for the Machine to simulate. Defaults to a performance-1x machine */
            compute?: components["schemas"]["fly.MachineGuest"];
            /**
             * @description Number of machines to simulate placement.
             *     Defaults to 0, which returns the org-specific limit for each region.
             */
            count?: number;
            /** @example personal */
            org_slug: string;
            /**
             * @description Region expression for placement as a comma-delimited set of regions or aliases.
             *     Defaults to "[region],any", to prefer the API endpoint's local region with any other region as fallback.
             * @example lhr,eu
             */
            region?: string;
            /** @example  */
            volume_name?: string;
            volume_size_bytes?: number;
            /**
             * @description Optional weights to override default placement preferences.
             * @example {
             *       "region": 1000,
             *       "spread": 0
             *     }
             */
            weights?: components["schemas"]["placement.Weights"];
        };
        "main.getPlacementsResponse": {
            regions?: components["schemas"]["placement.RegionPlacement"][];
        };
        "main.memoryResponse": {
            available_mb?: number;
            limit_mb?: number;
        };
        "main.reclaimMemoryRequest": {
            amount_mb?: number;
        };
        "main.reclaimMemoryResponse": {
            actual_mb?: number;
        };
        "main.regionResponse": {
            nearest?: string;
            regions?: components["schemas"]["main.regionRow"][];
        };
        "main.regionRow": {
            code?: string;
            deprecated?: boolean;
            gateway_available?: boolean;
            geo_region?: string;
            latitude?: number;
            longitude?: number;
            mpg_available?: boolean;
            name?: string;
            requires_paid_plan?: boolean;
        };
        "main.setMemoryLimitRequest": {
            limit_mb?: number;
        };
        /** @enum {string} */
        "main.statusCode": "unknown" | "insufficient_capacity" | "volume_placement_capacity" | "name_taken";
        "main.tokenInfo": {
            apps?: string[];
            org_slug?: string;
            organization?: string;
            /** @description Machine the token is restricted to (FromMachine caveat) */
            restricted_to_machine?: string;
            /** @description Machine making the request */
            source_machine_id?: string;
            token_id?: string;
            /** @description User identifier if token is for a user */
            user?: string;
        };
        metadataValueResponse: {
            value?: string;
        };
        "placement.RegionPlacement": {
            concurrency?: number;
            count?: number;
            region?: string;
        };
        "placement.Weights": {
            [key: string]: number;
        };
        postgresDatabaseResponse: {
            data?: components["schemas"]["PostgresDatabase"];
        };
        /** @enum {integer} */
        "resset.Action": 1 | 2 | 4 | 8 | 16 | 31 | 0;
        restorePostgresClusterRequest: {
            /** @description Backup label to restore from, as returned by the backups list. Mutually exclusive with pitr_time. */
            backup_id?: string;
            /** @description Name for the restored cluster. Defaults to a generated name derived from the source cluster and backup/point in time when omitted or blank. */
            name?: string;
            /** @description Point in time to restore to, as an RFC3339 timestamp with an explicit offset from UTC (e.g. Z or +02:00). Normalized to UTC and must fall within the cluster's PITR recovery window. Mutually exclusive with backup_id. */
            pitr_time?: string;
        };
        "root.VerifiedToken": {
            caveats?: components["schemas"]["macaroon.CaveatSet"];
            header?: string;
            nonce?: components["schemas"]["macaroon.Nonce"];
            permission_token?: number[];
        };
        rotatePostgresPasswordRequest: {
            /** @description Terminate the user's existing sessions after rotating. */
            kill_sessions?: boolean;
        };
        rotatePostgresPasswordResponse: {
            data?: components["schemas"]["PostgresUserCredentials"];
        };
        showPostgresClusterResponse: {
            data?: components["schemas"]["PostgresCluster"];
        };
        updateMetadataRequest: {
            machine_version?: string;
            metadata?: {
                [key: string]: string;
            };
            updated_at?: string;
        };
        updatePostgresUserRoleRequest: {
            /**
             * @description New role for the user.
             * @example reader
             * @enum {string}
             */
            role: "schema_admin" | "writer" | "reader";
        };
        upsertMetadataKeyRequest: {
            updated_at?: string;
            value?: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    Apps_list: {
        parameters: {
            query: {
                /** @description The org slug, or 'personal', to filter apps */
                org_slug: string;
                /** @description Filter apps by role */
                app_role?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ListAppsResponse"];
                };
            };
        };
    };
    Apps_create: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description App body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAppRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateAppResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Rejected by validation. status is name_taken when the app name is already in use. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Apps_show: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["App"];
                };
            };
        };
    };
    Apps_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    App_Certificates_list: {
        parameters: {
            query?: {
                /** @description Hostname filter (substring match) */
                filter?: string;
                /** @description Pagination cursor from previous response */
                cursor?: string;
                /** @description Number of results per page (default 25, max 500) */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listCertificatesResponse"];
                };
            };
        };
    };
    App_Certificates_acme_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        /** @description ACME certificate request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["createAcmeCertificateRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CertificateDetail"];
                };
            };
            /** @description Unprocessable Entity */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    App_Certificates_custom_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        /** @description Custom certificate request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["createCustomCertificateRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CertificateDetail"];
                };
            };
            /** @description Unprocessable Entity */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    App_Certificates_show: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Certificate Hostname */
                hostname: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CertificateDetail"];
                };
            };
        };
    };
    App_Certificates_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Certificate Hostname */
                hostname: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    App_Certificates_acme_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Certificate Hostname */
                hostname: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CertificateDetail"];
                };
            };
        };
    };
    App_Certificates_check: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Certificate Hostname */
                hostname: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CertificateCheckResponse"];
                };
            };
        };
    };
    App_Certificates_custom_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Certificate Hostname */
                hostname: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["destroyCustomCertificateResponse"];
                };
            };
        };
    };
    App_create_deploy_token: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAppDeployTokenRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateAppDeployTokenResponse"];
                };
            };
        };
    };
    App_IPAssignments_list: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listIPAssignmentsResponse"];
                };
            };
        };
    };
    App_IPAssignments_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        /** @description Assign IP request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["assignIPRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AssignIPResponse"];
                };
            };
        };
    };
    App_IPAssignments_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description IP address */
                ip: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_list: {
        parameters: {
            query?: {
                /** @description Include deleted machines */
                include_deleted?: boolean;
                /** @description Include machine leases */
                include_leases?: boolean;
                /** @description Region filter */
                region?: string;
                /** @description comma separated list of states to filter (created, started, stopped, suspended) */
                state?: string;
                /** @description Only return summary info about machines (omit config, checks, events, host_status, nonce, etc.) */
                summary?: boolean;
                /** @description Filter by a machine metadata key and exact value. Replace {key} with the metadata key, for example metadata.foo=bar. Specify multiple metadata filters to require all matches. */
                "metadata.{key}"?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Machine"][];
                };
            };
        };
    };
    Machines_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        /** @description Create machine request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateMachineRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Machine"];
                };
            };
        };
    };
    Machines_show: {
        parameters: {
            query?: {
                /** @description Include machine lease */
                include_leases?: boolean;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Machine"];
                };
            };
        };
    };
    Machines_update: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateMachineRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Machine"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_delete: {
        parameters: {
            query?: {
                /** @description Force kill the machine if it's running */
                force?: boolean;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_cordon: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_list_events: {
        parameters: {
            query?: {
                /** @description The number of events to fetch (max of 50). If omitted, this is set to 20 by default. */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineEvent"][];
                };
            };
        };
    };
    Machines_exec: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["MachineExecRequest"];
            };
        };
        responses: {
            /** @description stdout, stderr, exit code, and exit signal are returned */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["flydv1.ExecResponse"];
                    "application/octet-stream": components["schemas"]["flydv1.ExecResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                    "application/octet-stream": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_show_lease: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Lease"];
                };
            };
        };
    };
    Machines_create_lease: {
        parameters: {
            query?: never;
            header?: {
                /** @description Existing lease nonce to refresh by ttl, empty or non-existent to create a new lease */
                "fly-machine-lease-nonce"?: string;
            };
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateLeaseRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Lease"];
                };
            };
        };
    };
    Machines_release_lease: {
        parameters: {
            query?: never;
            header: {
                /** @description Existing lease nonce */
                "fly-machine-lease-nonce": string;
            };
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_get_memory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["main.memoryResponse"];
                };
            };
        };
    };
    Machines_set_memory_limit: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Set memory limit request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["main.setMemoryLimitRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["main.memoryResponse"];
                };
            };
        };
    };
    Machines_reclaim_memory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Reclaim memory request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["main.reclaimMemoryRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["main.reclaimMemoryResponse"];
                };
            };
        };
    };
    Machines_show_metadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
        };
    };
    Machines_update_metadata_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Update metadata request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["updateMetadataRequest"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Precondition Failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_update_metadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Update metadata request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["updateMetadataRequest"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Precondition Failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_get_metadata_key: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
                /** @description Metadata Key */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["metadataValueResponse"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_upsert_metadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
                /** @description Metadata Key */
                key: string;
            };
            cookie?: never;
        };
        /** @description Upsert metadata key request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["upsertMetadataKeyRequest"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_delete_metadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
                /** @description Metadata Key */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_list_processes: {
        parameters: {
            query?: {
                /** @description Sort by */
                sort_by?: string;
                /** @description Order */
                order?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProcessStat"][];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_restart: {
        parameters: {
            query?: {
                /** @description Restart timeout as a Go duration string or number of seconds */
                timeout?: string;
                /** @description Unix signal name */
                signal?: "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGKILL" | "SIGUSR1" | "SIGUSR2" | "SIGTERM";
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_signal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignalRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_start: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_stop: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        /** @description Optional request body */
        requestBody?: {
            content: {
                "application/json": components["schemas"]["StopRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Machines_suspend: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_uncordon: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_list_versions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachineVersion"][];
                };
            };
        };
    };
    Machines_wait: {
        parameters: {
            query?: {
                /** @description 26-character Machine version ID */
                version?: string;
                /** @description 26-character Machine version ID (deprecated; use version) */
                instance_id?: string;
                /** @description 26-character Machine event ID to start waiting after */
                from_event_id?: string;
                /** @description wait timeout. default 60s */
                timeout?: number;
                /** @description desired state(s), supports repeated or comma-separated values */
                state?: "started" | "stopped" | "suspended" | "destroyed" | "failed" | "settled";
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Machine ID */
                machine_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WaitMachineResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secretkeys_list: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
                /** @description Comma-seperated list of secret keys to list */
                types?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretKeys"];
                };
            };
        };
    };
    Secretkey_get: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretKey"];
                };
            };
        };
    };
    Secretkey_set: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        /** @description Create secret key request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetSecretkeyRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetSecretkeyResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secretkey_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteSecretkeyResponse"];
                };
            };
        };
    };
    Secretkey_decrypt: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        /** @description Decrypt with secret key request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["DecryptSecretkeyRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecryptSecretkeyResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secretkey_encrypt: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        /** @description Encrypt with secret key request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["EncryptSecretkeyRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EncryptSecretkeyResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secretkey_generate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        /** @description generate secret key request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetSecretkeyRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetSecretkeyResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secretkey_sign: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        /** @description Sign with secret key request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignSecretkeyRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignSecretkeyResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secretkey_verify: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Secret key name */
                secret_name: string;
            };
            cookie?: never;
        };
        /** @description Verify with secret key request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["VerifySecretkeyRequest"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secrets_list: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
                /** @description Show the secret values. */
                show_secrets?: boolean;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AppSecrets"];
                };
            };
        };
    };
    Secrets_update: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        /** @description Update app secret request, with values to set, or nil to unset */
        requestBody: {
            content: {
                "application/json": components["schemas"]["AppSecretsUpdateRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AppSecretsUpdateResp"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secret_get: {
        parameters: {
            query?: {
                /** @description Minimum secrets version to return. Returned when setting a new secret */
                min_version?: string;
                /** @description Show the secret value. */
                show_secrets?: boolean;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description App secret name */
                secret_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AppSecret"];
                };
            };
        };
    };
    Secret_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description App secret name */
                secret_name: string;
            };
            cookie?: never;
        };
        /** @description Create app secret request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetAppSecretRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetAppSecretResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Secret_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description App secret name */
                secret_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteAppSecretResponse"];
                };
            };
        };
    };
    Volumes_list: {
        parameters: {
            query?: {
                /** @description Only return summary info about volumes (omit blocks, block size, etc) */
                summary?: boolean;
            };
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Volume"][];
                };
            };
        };
    };
    Volumes_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateVolumeRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Volume"];
                };
            };
        };
    };
    Volumes_get_by_id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Volume ID */
                volume_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Volume"];
                };
            };
        };
    };
    Volumes_update: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Volume ID */
                volume_id: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateVolumeRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Volume"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Volume_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Volume ID */
                volume_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Volume"];
                };
            };
        };
    };
    Volumes_extend: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Volume ID */
                volume_id: string;
            };
            cookie?: never;
        };
        /** @description Request body */
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtendVolumeRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtendVolumeResponse"];
                };
            };
        };
    };
    Volumes_list_snapshots: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Volume ID */
                volume_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VolumeSnapshot"][];
                };
            };
        };
    };
    createVolumeSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Fly App Name */
                app_name: string;
                /** @description Volume ID */
                volume_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Machines_org_list: {
        parameters: {
            query?: {
                /** @description Include deleted machines */
                include_deleted?: boolean;
                /** @description Region filter */
                region?: string;
                /** @description Comma separated list of states to filter (created, started, stopped, suspended) */
                state?: string;
                /** @description Omit config from responses */
                summary?: boolean;
                /** @description Only return machines updated after this time. Timestamp must be in the RFC 3339 format */
                updated_after?: string;
                /** @description Pagination cursor from previous response (takes precedence over updated_after). Note that there is no guarantee that all machines returned by this endpoint are sorted by their updated_at fields. Pagination may reveal machines older than the last updated_at. */
                cursor?: string;
                /** @description The number of machines to fetch (max of 1000). This limit is advisory. Responses may be shorter, or even empty, even when more machines remain. If omitted, the maximum is used */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Fly Organization Slug */
                org_slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrgMachinesResponse"];
                };
            };
        };
    };
    Volumes_org_list: {
        parameters: {
            query?: {
                /** @description Include deleted volumes */
                include_deleted?: boolean;
                /** @description Region filter */
                region?: string;
                /** @description Comma separated list of volume states to filter */
                state?: string;
                /** @description Only return summary info about volumes (omit blocks, block size, etc) */
                summary?: boolean;
                /** @description Only return volumes updated after this time. Timestamp must be in the RFC 3339 format */
                updated_after?: string;
                /** @description Pagination cursor from previous response (takes precedence over updated_after) */
                cursor?: string;
                /** @description The number of volumes to fetch (max of 1000). This limit is advisory. Responses may be shorter, even when more volumes remain. If omitted, the maximum is used */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description Fly Organization Slug */
                org_slug: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrgVolumesResponse"];
                };
            };
        };
    };
    Platform_placements_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Get placements request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["main.getPlacementsRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["main.getPlacementsResponse"];
                };
            };
        };
    };
    Platform_regions_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["main.regionResponse"];
                };
            };
        };
    };
    Postgres_list: {
        parameters: {
            query: {
                /** @description Fly Organization Slug, or 'personal' for the caller's personal organization */
                org_slug: string;
                /** @description Include deleted clusters */
                include_deleted?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listPostgresClustersResponse"];
                };
            };
            /** @description org_slug is required and must be a string */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Organization not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description include_deleted must be true or false */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_create: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Cluster details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["createPostgresClusterRequest"];
            };
        };
        responses: {
            /** @description Cluster accepted for provisioning */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["showPostgresClusterResponse"];
                };
            };
            /** @description org_slug is required and must be a string, or creation failed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Organization not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Invalid attributes */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_show: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["showPostgresClusterResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'This cluster has been deleted' or 'This cluster is being deleted' */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_attachments_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        /** @description Attachment details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["createPostgresAttachmentRequest"];
            };
        };
        responses: {
            /** @description Cluster was already attached */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["createPostgresAttachmentResponse"];
                };
            };
            /** @description Attachment created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["createPostgresAttachmentResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'App not found' for the app */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'This cluster has been deleted' or 'This cluster is being deleted' */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_attachments_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Fly App Name */
                app_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'App not found' for the app; 'Attachment not found' for the attachment */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'This cluster has been deleted' or 'This cluster is being deleted' */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_backups_list: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listPostgresBackupsResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_backups_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        /** @description Backup details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["createPostgresBackupRequest"];
            };
        };
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description A backup is currently running */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_databases_list: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listPostgresDatabasesResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_databases_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        /** @description Database details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["createPostgresDatabaseRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["postgresDatabaseResponse"];
                };
            };
            /** @description Database name is reserved, a system database, or malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description name is required */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_databases_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Database Name */
                database_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["postgresDatabaseResponse"];
                };
            };
            /** @description Database name is reserved, a system database, or malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'Database not found' for the database */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_extensions_list: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Database Name */
                database_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listPostgresExtensionsResponse"];
                };
            };
            /** @description Database name is malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_extensions_enable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Database Name */
                database_name: string;
            };
            cookie?: never;
        };
        /** @description Extension details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["enablePostgresExtensionRequest"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Database name is malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'PostGIS is not enabled on this cluster' or 'Extension <name> is already installed in schema <schema>' */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unknown or unsupported extension */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_extensions_disable: {
        parameters: {
            query?: {
                /** @description Also drop objects that depend on the extension */
                force?: boolean;
            };
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Database Name */
                database_name: string;
                /** @description Extension Name */
                extension_name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description 'System extensions cannot be disabled' or 'Database name is malformed' */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Invalid extension name */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_fork: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        /** @description Fork details */
        requestBody?: {
            content: {
                "application/json": components["schemas"]["forkPostgresClusterRequest"];
            };
        };
        responses: {
            /** @description New cluster provisioned from the fork */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["showPostgresClusterResponse"];
                };
            };
            /** @description Fork failed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description The source cluster is not ready to be forked yet */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'This cluster has been deleted' or 'This cluster is being deleted' */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Invalid attributes */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_queries_active: {
        parameters: {
            query: {
                /** @description Database to inspect (must not be empty or whitespace-only) */
                database: string;
            };
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listPostgresActiveQueriesResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description database must be a non-empty string */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unable to load active queries */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_queries_slow: {
        parameters: {
            query?: {
                /** @description Metrics lookback in seconds */
                range?: number;
            };
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listPostgresSlowQueriesResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description range must be an integer between 1 and 604800 seconds */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unable to load slow query metrics */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_restore: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        /** @description Restore details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["restorePostgresClusterRequest"];
            };
        };
        responses: {
            /** @description New cluster provisioned from the backup or point in time */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["showPostgresClusterResponse"];
                };
            };
            /** @description Restore failed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'Backup <backup_id> not found for cluster <postgres_cluster_id>' for the backup */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description A restore target is missing, both backup_id and pitr_time were supplied, point-in-time restore is outside the recovery window or unavailable, or name is invalid */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_users_list: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["listPostgresUsersResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_users_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
            };
            cookie?: never;
        };
        /** @description User details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["createPostgresUserRequest"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["createPostgresUserResponse"];
                };
            };
            /** @description Username is reserved, a system user, or malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Cluster not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description User already exists */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description username or role missing, or role invalid */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_users_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Postgres User Name */
                username: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Username is reserved, a system user, or malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'User not found' for the user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_users_update_role: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Postgres User Name */
                username: string;
            };
            cookie?: never;
        };
        /** @description Role details */
        requestBody: {
            content: {
                "application/json": components["schemas"]["updatePostgresUserRoleRequest"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Username is reserved, a system user, or malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'User not found' for the user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description role missing or invalid */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_users_credentials: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Postgres User Name */
                username: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["getPostgresUserCredentialsResponse"];
                };
            };
            /** @description Username is reserved, a system user, or malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'User not found' for the user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Postgres_users_rotate_password: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Managed Postgres Cluster ID */
                postgres_cluster_id: string;
                /** @description Postgres User Name */
                username: string;
            };
            cookie?: never;
        };
        /** @description Password rotation details */
        requestBody?: {
            content: {
                "application/json": components["schemas"]["rotatePostgresPasswordRequest"];
            };
        };
        responses: {
            /** @description Rotated user credentials */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["rotatePostgresPasswordResponse"];
                };
            };
            /** @description Username is reserved, a system user, or malformed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'Cluster not found' for the cluster; 'User not found' for the user */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description 'This cluster has been deleted' or 'This cluster is being deleted' */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description kill_sessions must be true or false */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
            /** @description pg-admin is unavailable; retry after the interval given by the Retry-After header */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostgresErrorResponse"];
                };
            };
        };
    };
    Tokens_authenticate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Authenticate token request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["authenticateTokenRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["root.VerifiedToken"][];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Tokens_authorize: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Authorize token request */
        requestBody: {
            content: {
                "application/json": components["schemas"]["authorizeTokenRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["authorizeResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal Server Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    CurrentToken_show: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CurrentTokenResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal Server Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    Tokens_request_Kms: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description KMS token */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
        };
    };
    Tokens_request_OIDC: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Optional request body */
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CreateOIDCTokenRequest"];
            };
        };
        responses: {
            /** @description OIDC token */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
}
