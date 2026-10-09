// Generated from infra/hangar/hangar.openapi.json (sha256 7def765db60bf511dd00b390d2b9e9866c1c6432a0ef68642d12a17670119f37) by tools/openapi.
// Do not edit. Regenerate with `bun run openapi:generate`; update the spec with `bun run openapi:update hangar`.

export interface paths {
    "/api/v1/authenticate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Creates an API JWT
         * @description `Log-in` with your API key in order to be able to call other endpoints authenticated. The returned JWT should be specified as a header in all following requests: `Authorization: HangarAuth your.jwt`
         */
        post: operations["authenticate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/authors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns all users with at least one public project
         * @description Returns all users that have at least one public project. Requires the `view_public_info` permission.
         */
        get: operations["getAuthors"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetches a list of API Keys
         * @description Fetches a list of API Keys. Requires the `edit_api_keys` permission.
         */
        get: operations["getKeys"];
        put?: never;
        /**
         * Creates an API key
         * @description Creates an API key. Requires the `edit_api_keys` permission.
         */
        post: operations["createKey"];
        /**
         * Deletes an API key
         * @description Deletes an API key. Requires the `edit_api_keys` permission.
         */
        delete: operations["deleteKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/pages/edit/{project}": {
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
         * Edits a page of a project
         * @description Edits a page of a project. Requires the `edit_page` permission in the project or owning organization.
         */
        patch: operations["editPage"];
        trace?: never;
    };
    "/api/v1/pages/editmain/{project}": {
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
         * Edits the main page of a project
         * @description Edits the main page of a project. Requires the `edit_page` permission in the project or owning organization.
         */
        patch: operations["editMainPage"];
        trace?: never;
    };
    "/api/v1/pages/main/{project}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the main page of a project
         * @description Returns the main page of a project. Requires visibility of the page.
         */
        get: operations["getMainPage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/pages/page/{project}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns a page of a project
         * @description Returns a page of a project. Requires visibility of the page.
         */
        get: operations["getPage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/permissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns your permissions
         * @description Returns a list of permissions you have in the given context
         */
        get: operations["showPermissions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/permissions/hasAll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Checks whether you have all the provided permissions
         * @description Checks whether you have all the provided permissions in the given context
         */
        get: operations["hasAll"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/permissions/hasAny": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Checks whether you have at least one of the provided permissions
         * @description Checks whether you have at least one of the provided permissions in the given context
         */
        get: operations["hasAny"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/platforms/{platform}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Gets a list of versions for a platform
         * @description Gets a list of platform versions, including children.
         */
        get: operations["getPlatformVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Searches the projects on Hangar
         * @description Searches all the projects on Hangar, or for a single user. Requires the `view_public_info` permission.
         */
        get: operations["getProjects"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns info on a specific project
         * @description Returns info on a specific project. Requires the `view_public_info` permission.
         */
        get: operations["getProject"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/latest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the latest version of a project for a specific channel
         * @description Returns the latest version of a project. Requires the `view_public_info` permission in the project or owning organization.
         */
        get: operations["latestVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/latestrelease": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the latest release version of a project
         * @description Returns the latest version of a project. Requires the `view_public_info` permission in the project or owning organizations.
         */
        get: operations["latestReleaseVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the members of a project
         * @description Returns the members of a project. Requires the `view_public_info` permission.
         */
        get: operations["getProjectMembers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/stargazers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the stargazers of a project
         * @description Returns the stargazers of a project. Requires the `view_public_info` permission.
         */
        get: operations["getProjectStargazers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the stats for a project
         * @description Returns the stats (downloads and views) for a project per day for a certain date range. Requires the `is_subject_member` permission.
         */
        get: operations["showProjectStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Creates a new version and returns parts of its metadata
         * @description Creates a new version for a project. Requires the `create_version` permission in the project or owning organization.
         *     Make sure you provide the contents of this request as multipart/form-data.
         *     You can find a simple example implementation written in Java here: https://gist.github.com/kennytv/a227d82249f54e0ad35005330256fee2
         */
        post: operations["uploadVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns all versions of a project
         * @description Returns all versions of a project. Requires the `view_public_info` permission in the project or owning organization.
         */
        get: operations["listVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/versions/{nameOrId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns a specific version of a project
         * @description Returns a specific version of a project. Requires the `view_public_info` permission in the project or owning organization.
         */
        get: operations["showVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/versions/{nameOrId}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the stats for a version
         * @description Returns the stats (downloads) for a version per day for a certain date range. Requires the `is_subject_member` permission.
         */
        get: operations["showVersionStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/versions/{nameOrId}/{platform}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Downloads a version
         * @description Downloads the file for a specific platform of a version. Requires visibility of the project and version.
         */
        get: operations["downloadVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{slugOrId}/watchers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the watchers of a project
         * @description Returns the watchers of a project. Requires the `view_public_info` permission.
         */
        get: operations["getProjectWatchers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/staff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns Hangar staff
         * @description Returns Hanagr staff. Requires the `view_public_info` permission.
         */
        get: operations["getStaff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Searches for users
         * @description Returns a list of users based on a search query. Requires the `view_public_info` permission.
         */
        get: operations["showUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns a specific user
         * @description Returns a specific user. Requires the `view_public_info` permission.
         */
        get: operations["getUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user}/pinned": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the pinned projects for a specific user
         * @description Returns the pinned projects for a specific user. Requires the `view_public_info` permission.
         */
        get: operations["getUserPinnedProjects"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user}/starred": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the starred projects for a specific user
         * @description Returns the starred projects for a specific user. Requires the `view_public_info` permission.
         */
        get: operations["showStarred"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/{user}/watching": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the watched projects for a specific user
         * @description Returns the watched projects for a specific user. Requires the `view_public_info` permission.
         */
        get: operations["getUserWatching"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/versions/hash/{hash}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Returns project of the first version that matches the given file hash (SHA-256) */
        get: operations["projectByVersionHash"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/versions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns a specific version by its ID
         * @description Returns a specific version by its ID. Requires the `view_public_info` permission in the project or owning organization.
         */
        get: operations["showVersionById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/versions/{id}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Returns the stats for a version by its ID
         * @description Returns the stats (downloads) for a version per day for a certain date range. Requires the `is_subject_member` permission.
         */
        get: operations["showVersionStatsById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/versions/{id}/{platform}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Downloads a version by its ID
         * @description Downloads the file for a specific platform of a version. Requires visibility of the project and version.
         */
        get: operations["downloadVersionById"];
        put?: never;
        post?: never;
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
        AccountForm: {
            currentPassword: string;
            email: string;
            newPassword?: string;
            username: string;
        };
        Announcement: {
            color?: string;
            text?: string;
        };
        AnnouncementTable: {
            color?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            createdBy?: number;
            /** Format: int64 */
            id?: number;
            text?: string;
        };
        ApiKey: {
            /** Format: date-time */
            createdAt?: string;
            /**
             * Format: date-time
             * @description The time the key stops working, if it was created with an expiration date
             */
            expiresAt?: string;
            /** Format: date-time */
            lastUsed?: string;
            name?: string;
            permissions?: components["schemas"]["NamedPermission"][];
            /** @description Whether the key may only be used on the projects listed below */
            projectScoped?: boolean;
            /** @description The projects the key is limited to, empty unless the key is project scoped */
            projects?: components["schemas"]["ProjectNamespace"][];
            tokenIdentifier?: string;
        };
        ApiSession: {
            /**
             * Format: int64
             * @description Milliseconds this JWT expires in
             */
            expiresIn?: number;
            /** @description JWT used for authentication */
            token?: string;
        };
        Authenticator: {
            addedAt?: string;
            displayName?: string;
            id?: string;
        };
        BackupCode: {
            code?: string;
            /** Format: date-time */
            used_at?: string;
        };
        /** @enum {string} */
        Category: "admin_tools" | "chat" | "dev_tools" | "economy" | "gameplay" | "games" | "protection" | "role_playing" | "world_management" | "misc" | "undefined";
        CategoryData: {
            apiName?: string;
            icon?: string;
            title?: string;
            visible?: boolean;
        };
        ChangeRoleForm: {
            color: string;
            /** Format: int32 */
            rank?: number;
            /** Format: int64 */
            roleId?: number;
            title: string;
        };
        /** @enum {string} */
        ChannelFlag: "FROZEN" | "UNSTABLE" | "PINNED" | "SENDS_NOTIFICATIONS" | "HIDE_BY_DEFAULT";
        ChannelForm: {
            color: components["schemas"]["Color"];
            description?: string;
            flags?: components["schemas"]["ChannelFlag"][];
            name: string;
        };
        /** @enum {string} */
        Color: "#d946ef" | "#a855f7" | "#8b5cf6" | "#6366f1" | "#3b82f6" | "#0ea5e9" | "#06b6d4" | "#14b8a6" | "#34d399" | "#22c55e" | "#84cc16" | "#eab308" | "#f59e0b" | "#f97316" | "#ef4444" | "#78716c" | "#A9A9A9" | "transparent";
        ColorData: {
            hex?: string;
            name?: string;
        };
        /** @enum {string} */
        Context: "PROJECT" | "VERSION" | "PAGE" | "USER" | "ORGANIZATION";
        /** @description Data about the key to create */
        CreateAPIKeyForm: {
            /**
             * Format: date-time
             * @description Point in time at which the key stops working. Leave empty for a key that never expires
             */
            expiresAt?: string;
            name: string;
            permissions: components["schemas"]["NamedPermission"][];
            /** @description Slugs of the projects the key may be used on. Leave empty to allow all projects */
            projects?: string[];
        };
        CreateOrganizationForm: {
            members?: components["schemas"]["OrgMember"][];
            name?: string;
        };
        CreateUserRequest: {
            admin?: boolean;
            email?: string;
            password?: string;
            username?: string;
        };
        /** @enum {string} */
        CredentialType: "PASSWORD" | "BACKUP_CODES" | "TOTP" | "WEBAUTHN" | "OAUTH";
        DayProjectStats: {
            /** Format: int64 */
            downloads?: number;
            /** Format: int64 */
            views?: number;
        };
        DayStats: {
            /** Format: date */
            day?: string;
            /** Format: int64 */
            downloads?: number;
            /** Format: int64 */
            flagsClosed?: number;
            /** Format: int64 */
            flagsOpened?: number;
            /** Format: int64 */
            newProjects?: number;
            /** Format: int64 */
            newUsers?: number;
            /** Format: int64 */
            reviews?: number;
            /** Format: int64 */
            uploads?: number;
            /** Format: int64 */
            views?: number;
        };
        Details: {
            /** Format: int32 */
            indexedDocuments?: number;
            /** Format: int32 */
            receivedDocuments?: number;
        };
        EditChannelForm: {
            color: components["schemas"]["Color"];
            description?: string;
            flags?: components["schemas"]["ChannelFlag"][];
            /** Format: int64 */
            id?: number;
            name: string;
        };
        Error: {
            code?: string;
            link?: string;
            message?: string;
            type?: string;
        };
        ExcludedProject: {
            /** Format: date-time */
            createdAt?: string;
            excludedBy?: string;
            name?: string;
            namespace?: components["schemas"]["ProjectNamespace"];
            /** Format: int64 */
            projectId?: number;
        };
        FileInfo: {
            name?: string;
            sha256Hash?: string;
            /** Format: int64 */
            sizeBytes?: number;
        };
        FileSizeCheck: {
            /** Format: int64 */
            fileCount?: number;
            namespace?: components["schemas"]["ProjectNamespace"];
            /** Format: int64 */
            totalSize?: number;
        };
        FinishedOrPendingHealthReport: {
            finished?: components["schemas"]["HealthReport"];
            pending?: components["schemas"]["PendingHealthReport"];
        };
        FlagActivity: {
            namespace?: components["schemas"]["ProjectNamespace"];
            /** Format: date-time */
            resolvedAt?: string;
        };
        FlagForm: {
            comment: string;
            /** Format: int64 */
            projectId?: number;
            reason: components["schemas"]["FlagReason"];
        };
        /** @enum {string} */
        FlagReason: "project.flag.flags.inappropriateContent" | "project.flag.flags.impersonation" | "project.flag.flags.spam" | "project.flag.flags.malIntent" | "project.flag.flags.other";
        FlagReasonData: {
            title?: string;
            type?: string;
        };
        GlobalData: {
            announcements?: components["schemas"]["Announcement"][];
            globalNotifications?: {
                [key: string]: string;
            };
            platforms?: components["schemas"]["PlatformData"][];
        };
        GlobalNotificationTable: {
            /** Format: date-time */
            activeFrom?: string;
            /** Format: date-time */
            activeTo?: string;
            color?: string;
            content?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            createdBy?: number;
            /** Format: int64 */
            id?: number;
            key?: string;
        };
        HangarChannel: {
            color?: components["schemas"]["Color"];
            /** Format: date-time */
            createdAt?: string;
            description?: string;
            flags?: components["schemas"]["ChannelFlag"][];
            /** Format: int64 */
            id?: number;
            name?: string;
            /** Format: int64 */
            projectId?: number;
            /** Format: int32 */
            versionCount?: number;
        };
        HangarLoggedAction: {
            action?: components["schemas"]["LogActionObject"];
            address?: {
                /** Format: byte */
                address?: string;
                anyLocalAddress?: boolean;
                canonicalHostName?: string;
                hostAddress?: string;
                hostName?: string;
                linkLocalAddress?: boolean;
                loopbackAddress?: boolean;
                mcglobal?: boolean;
                mclinkLocal?: boolean;
                mcnodeLocal?: boolean;
                mcorgLocal?: boolean;
                mcsiteLocal?: boolean;
                multicastAddress?: boolean;
                siteLocalAddress?: boolean;
            };
            contextType?: components["schemas"]["Context"];
            /** Format: date-time */
            createdAt?: string;
            newState?: string;
            oldState?: string;
            page?: components["schemas"]["LogPage"];
            project?: components["schemas"]["LogProject"];
            subject?: components["schemas"]["LogSubject"];
            /** Format: int64 */
            userId?: number;
            userName?: string;
            version?: components["schemas"]["LogVersion"];
        };
        HangarNotification: {
            action?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            id?: number;
            message?: string[];
            originUserName?: string;
            read?: boolean;
            type?: components["schemas"]["NotificationType"];
        };
        HangarOrganization: {
            /** Format: int64 */
            id?: number;
            members?: components["schemas"]["JoinableMemberOrganizationRoleTable"][];
            owner?: components["schemas"]["ProjectOwner"];
            owner2?: components["schemas"]["ProjectOwner"];
            roleCategory?: string;
        };
        HangarOrganizationInvite: {
            /** Format: date-time */
            createdAt?: string;
            name?: string;
            /** Format: int64 */
            roleId?: number;
            title?: string;
            type?: components["schemas"]["InviteType"];
            url?: string;
        };
        HangarProject: {
            /** @description The url to the project's icon */
            avatarUrl?: string;
            /** @description The category of the project */
            category?: components["schemas"]["Category"];
            /** Format: date-time */
            createdAt?: string;
            /** @description The short description of the project */
            description?: string;
            /**
             * Format: int64
             * @description The internal id of the project
             */
            id?: number;
            info?: components["schemas"]["HangarProjectInfo"];
            /**
             * Format: date-time
             * @description The last time the project was updated
             */
            lastUpdated?: string;
            lastVisibilityChangeComment?: string;
            lastVisibilityChangeUserName?: string;
            mainChannelVersions?: {
                [key: string]: components["schemas"]["Version"];
            };
            mainPage?: components["schemas"]["ProjectPageTable"];
            /** @description The content of the main page */
            mainPageContent?: string;
            /** @description The names of the members of the project */
            memberNames?: string[];
            members?: components["schemas"]["JoinableMemberProjectRoleTable"][];
            /** @description The unique name of the project */
            name?: string;
            /** @description The namespace of the project */
            namespace?: components["schemas"]["ProjectNamespace"];
            owner2?: components["schemas"]["ProjectOwner"];
            pages?: components["schemas"]["HangarProjectPage"][];
            pinnedVersions?: components["schemas"]["PinnedVersion"][];
            /** Format: int64 */
            projectId?: number;
            /**
             * Format: date-time
             * @description The time the project's first version was published
             */
            publishedAt?: string | null;
            roleCategory?: string;
            /** @description The settings of the project */
            settings?: components["schemas"]["ProjectSettings"];
            /** @description Stats of the project */
            stats?: components["schemas"]["ProjectStats"];
            /** @description The platforms and versions the project supports */
            supportedPlatforms?: {
                [key: string]: string[];
            };
            /** @description Information about your interactions with the project */
            userActions?: components["schemas"]["UserActions"];
            /** @description The visibility of the project */
            visibility?: components["schemas"]["Visibility"];
        };
        HangarProjectApproval: {
            changeRequester?: string;
            comment?: string;
            namespace?: components["schemas"]["ProjectNamespace"];
            /** Format: int64 */
            projectId?: number;
            visibility?: components["schemas"]["Visibility"];
        };
        HangarProjectFlag: {
            comment?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            id?: number;
            /** Format: int64 */
            projectId?: number;
            projectNamespace?: components["schemas"]["ProjectNamespace"];
            projectVisibility?: components["schemas"]["Visibility"];
            reason?: components["schemas"]["FlagReason"];
            reportedByName?: string;
            resolved?: boolean;
            /** Format: date-time */
            resolvedAt?: string;
            /** Format: int64 */
            resolvedBy?: number;
            resolvedByName?: string;
            /** Format: int64 */
            userId?: number;
        };
        HangarProjectFlagNotification: {
            /** Format: int64 */
            id?: number;
            message?: string[];
            originUserName?: string;
            type?: components["schemas"]["NotificationType"];
            /** Format: int64 */
            userId?: number;
        };
        HangarProjectInfo: {
            /** Format: int32 */
            flagCount?: number;
            /** Format: int32 */
            noteCount?: number;
            /** Format: int32 */
            publicVersions?: number;
            /** Format: int64 */
            starCount?: number;
            /** Format: int64 */
            watcherCount?: number;
        };
        HangarProjectInvite: {
            /** Format: date-time */
            createdAt?: string;
            name?: string;
            representingOrg?: string;
            /** Format: int64 */
            roleId?: number;
            title?: string;
            type?: components["schemas"]["InviteType"];
            url?: string;
        };
        HangarProjectNote: {
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            id?: number;
            message?: string;
            /** Format: int64 */
            projectId?: number;
            /** Format: int64 */
            userId?: number;
            userName?: string;
        };
        HangarProjectPage: {
            children?: components["schemas"]["HangarProjectPage"][];
            home?: boolean;
            /** Format: int64 */
            id?: number;
            name?: string;
            slug?: string;
        };
        HangarReview: {
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            endedAt?: string;
            messages?: components["schemas"]["HangarReviewMessage"][];
            /** Format: int64 */
            userId?: number;
            userName?: string;
        };
        HangarReviewMessage: {
            action?: components["schemas"]["ReviewAction"];
            args?: Record<string, never>;
            /** Format: date-time */
            createdAt?: string;
            message?: string;
        };
        HangarReviewQueueEntry: {
            channelColor?: components["schemas"]["Color"];
            channelName?: string;
            namespace?: components["schemas"]["ProjectNamespace"];
            platforms?: components["schemas"]["Platform"][];
            reviews?: components["schemas"]["Review"][];
            versionAuthor?: string;
            /** Format: date-time */
            versionCreatedAt?: string;
            /** Format: int64 */
            versionId?: number;
            versionString?: string;
        };
        HangarUser: {
            /** Format: int32 */
            aal?: number | null;
            accessToken?: string | null;
            avatarUrl?: string;
            /** Format: date-time */
            createdAt?: string;
            email?: string;
            headerData?: components["schemas"]["HeaderData"];
            /** Format: int64 */
            id?: number;
            isOrganization?: boolean;
            language?: string;
            /** Format: date-time */
            lastSeenChangelogAt?: string | null;
            locked?: boolean;
            name?: string;
            nameHistory?: components["schemas"]["UserNameChange"][] | null;
            /** Format: int64 */
            projectCount?: number;
            readPrompts?: number[];
            roles?: number[];
            socials?: components["schemas"]["JsonNode"];
            tagline?: string;
            theme?: string;
            /** Format: uuid */
            uuid?: string;
        };
        HeaderData: {
            globalPermission?: string;
            /** Format: int64 */
            organizationCount?: number;
            /** Format: int64 */
            projectApprovals?: number;
            /** Format: int64 */
            reviewQueueCount?: number;
            unreadCount?: components["schemas"]["UnreadCount"];
            /** Format: int64 */
            unresolvedFlags?: number;
        };
        HealthReport: {
            erroredJobs?: components["schemas"]["JobTable"][];
            fileSizes?: components["schemas"]["FileSizeCheck"][];
            /** Format: date-time */
            generatedAt?: string;
            missingFiles?: components["schemas"]["MissingFileCheck"][];
            nonPublicProjects?: components["schemas"]["UnhealthyProject"][];
            staleProjects?: components["schemas"]["UnhealthyProject"][];
        };
        /** @enum {string} */
        InviteStatus: "ACCEPT" | "DECLINE";
        /** @enum {string} */
        InviteType: "project" | "organization";
        Invites: {
            organization?: components["schemas"]["HangarOrganizationInvite"][];
            project?: components["schemas"]["HangarProjectInvite"][];
        };
        JarScanEntry: {
            checkName?: string;
            checked?: boolean;
            /** Format: date-time */
            checkedAt?: string;
            /** Format: int64 */
            checkedBy?: number;
            /** Format: int64 */
            id?: number;
            location?: string;
            message?: string;
            severity?: string;
        };
        JarScanResult: {
            /** Format: date-time */
            createdAt?: string;
            entries?: components["schemas"]["JarScanEntry"][];
            highestSeverity?: string;
            /** Format: int64 */
            id?: number;
            platform?: components["schemas"]["Platform"];
        };
        JobState: {
            null?: boolean;
            type?: string;
            value?: string;
        };
        JobTable: {
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            id?: number;
            jobProperties?: components["schemas"]["JsonNode"];
            jobType?: components["schemas"]["JobType"];
            lastError?: string;
            lastErrorDescriptor?: string;
            /** Format: date-time */
            lastUpdated?: string;
            /** Format: date-time */
            retryAt?: string;
            state?: components["schemas"]["JobState"];
        };
        /** @enum {string} */
        JobType: "SEND_EMAIL" | "SEND_WEBHOOK" | "SCHEDULED_TASK";
        JoinableMemberOrganizationRoleTable: {
            hidden?: boolean;
            role?: components["schemas"]["OrganizationRoleTable"];
            user?: components["schemas"]["UserTable"];
        };
        JoinableMemberProjectRoleTable: {
            hidden?: boolean;
            role?: components["schemas"]["ProjectRoleTable"];
            user?: components["schemas"]["UserTable"];
        };
        JsonNode: unknown;
        Link: {
            /** Format: int64 */
            id?: number;
            name?: string;
            url: string;
        };
        LinkSection: {
            /** Format: int64 */
            id?: number;
            links: components["schemas"]["Link"][];
            title?: string;
            /**
             * @description Type of the link. Either SIDEBAR or TOP
             * @example TOP
             */
            type: string;
        };
        LogActionObject: {
            description?: string;
            name?: string;
            pgLoggedAction?: string;
        };
        LogPage: {
            /** Format: int64 */
            id?: number;
            name?: string;
            slug?: string;
        };
        LogProject: {
            /** Format: int64 */
            id?: number;
            owner?: string;
            slug?: string;
        };
        LogSubject: {
            /** Format: int64 */
            id?: number;
            name?: string;
        };
        LogVersion: {
            /** Format: int64 */
            id?: number;
            versionString?: string;
        };
        LoginBackupForm: {
            backupCode?: string;
            password?: string;
            usernameOrEmail?: string;
        };
        LoginPasswordForm: {
            password?: string;
            usernameOrEmail?: string;
        };
        LoginResponse: {
            /** Format: int32 */
            aal?: number;
            types?: components["schemas"]["CredentialType"][];
            user?: components["schemas"]["HangarUser"];
        };
        LoginTotpForm: {
            password?: string;
            totpCode?: string;
            usernameOrEmail?: string;
        };
        LoginWebAuthNForm: {
            password?: string;
            publicKeyCredentialJson?: string;
            usernameOrEmail?: string;
        };
        MissingFileCheck: {
            fileNames?: string[];
            namespace?: components["schemas"]["ProjectNamespace"];
            platforms?: components["schemas"]["Platform"][];
            versionString?: string;
        };
        /** @description List of different jars/external links that are part of the version */
        MultipartFileOrUrl: {
            /**
             * @description External url to download the jar from if not provided via an attached jar, else null
             * @example https://papermc.io/downloads
             */
            externalUrl?: string;
            /**
             * @description List of platforms this jar runs on
             * @example [PAPER, WATERFALL, VELOCITY]
             */
            platforms?: components["schemas"]["Platform"][];
        };
        /** @enum {string} */
        NamedPermission: "view_public_info" | "edit_own_user_settings" | "edit_api_keys" | "edit_subject_settings" | "manage_subject_members" | "is_subject_owner" | "is_subject_member" | "create_project" | "edit_page" | "delete_project" | "create_version" | "edit_version" | "delete_version" | "edit_channels" | "create_organization" | "delete_organization" | "mod_notes_and_flags" | "see_hidden" | "is_staff" | "reviewer" | "view_health" | "view_ip" | "view_stats" | "view_logs" | "manual_value_changes" | "restore_version" | "restore_project" | "hard_delete_project" | "hard_delete_version" | "edit_all_user_settings";
        NewProjectForm: {
            avatarUrl?: string;
            category: components["schemas"]["Category"];
            description: string;
            name: string;
            /** Format: int64 */
            ownerId?: number;
            pageContent?: string;
            settings?: components["schemas"]["ProjectSettings"];
        };
        NewProjectPage: {
            name: string;
            /** Format: int64 */
            parentId?: number;
        };
        /** @enum {string} */
        NotificationType: "neutral" | "success" | "info" | "warning" | "error";
        OAuthConnection: {
            id?: string;
            name?: string;
            provider?: string;
        };
        /** @enum {string} */
        OAuthMode: "LOGIN" | "SIGNUP" | "SETTINGS";
        OAuthSignupForm: {
            email?: string;
            jwt?: string;
            tos?: boolean;
            username?: string;
        };
        OAuthSignupResponse: {
            emailVerificationNeeded?: boolean;
        };
        OrgMember: {
            name: string;
            permissions?: components["schemas"]["NamedPermission"][];
            title?: string;
        };
        OrganizationRoleTable: {
            accepted?: boolean;
            avatarUrl?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            id?: number;
            owner?: boolean;
            /** Format: int64 */
            ownerId?: number;
            ownerName?: string;
            permissions?: components["schemas"]["NamedPermission"][];
            /** Format: int64 */
            principalId?: number;
            title?: string;
            /** Format: int64 */
            userId?: number;
            /** Format: uuid */
            uuid?: string;
        };
        /** @description The path and new contents of the page */
        PageEditForm: {
            content: string;
            path: string;
        };
        PaginatedResultHangarLoggedAction: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["HangarLoggedAction"][];
        };
        PaginatedResultHangarNotification: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["HangarNotification"][];
        };
        PaginatedResultHangarProjectFlag: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["HangarProjectFlag"][];
        };
        PaginatedResultProject: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["Project"][];
        };
        PaginatedResultProjectCompact: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["ProjectCompact"][];
        };
        PaginatedResultProjectMember: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["ProjectMember"][];
        };
        PaginatedResultUser: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["User"][];
        };
        PaginatedResultVersion: {
            pagination?: components["schemas"]["Pagination"];
            result?: components["schemas"]["Version"][];
        };
        Pagination: {
            /** Format: int64 */
            count?: number;
            /**
             * Format: int64
             * @description The maximum amount of items to return
             * @example 1
             */
            limit?: number;
            /**
             * Format: int64
             * @description Where to start searching
             * @example 0
             */
            offset?: number;
        };
        PendingHealthReport: {
            queuedAt?: string;
            queuedBy?: string;
            status?: string;
        };
        PendingVersion: {
            channelColor?: components["schemas"]["Color"];
            channelDescription?: string;
            channelFlags?: components["schemas"]["ChannelFlag"][];
            channelName: string;
            description: string;
            files: components["schemas"]["PendingVersionFile"][];
            platformDependencies: {
                [key: string]: string[];
            };
            pluginDependencies?: {
                [key: string]: components["schemas"]["PluginDependency"][];
            };
            versionString: string;
        };
        PendingVersionFile: {
            externalUrl?: string;
            fileInfo?: components["schemas"]["FileInfo"];
            platforms?: components["schemas"]["Platform"][];
        };
        PermissionCheck: {
            result?: boolean;
            type?: components["schemas"]["PermissionType"];
        };
        PermissionData: {
            frontendName?: string;
            permission?: string;
            value?: string;
        };
        /** @description A set of related permissions, presented together when editing a member */
        PermissionGroup: {
            /** @description i18n key suffix under 'permissionGroup.' */
            name?: string;
            permissions?: components["schemas"]["NamedPermission"][];
        };
        /** @enum {string} */
        PermissionType: "global" | "project" | "organization";
        /** @enum {string} */
        PinnedStatus: "NONE" | "VERSION" | "CHANNEL";
        PinnedVersion: {
            channel?: components["schemas"]["ProjectChannel"];
            downloads?: {
                [key: string]: components["schemas"]["PlatformVersionDownload"];
            };
            name?: string;
            platformDependencies?: {
                [key: string]: string[];
            };
            platformDependenciesFormatted?: {
                [key: string]: string[];
            };
            type?: components["schemas"]["Type"];
            /** Format: int64 */
            versionId?: number;
        };
        /**
         * @description Server platform
         * @example PAPER
         * @enum {string}
         */
        Platform: "PAPER" | "WATERFALL" | "VELOCITY";
        PlatformData: {
            category?: components["schemas"]["Category"];
            enumName?: string;
            name?: string;
            platformVersions?: components["schemas"]["PlatformVersion"][];
            url?: string;
            visible?: boolean;
        };
        PlatformDownloads: {
            /** Format: int64 */
            downloads?: number;
            platform?: components["schemas"]["Platform"];
        };
        PlatformVersion: {
            /** Format: int32 */
            platform?: number;
            versions?: string[];
        };
        PlatformVersionDownload: {
            /** @description Hangar download url if not an external download */
            downloadUrl?: string;
            /** @description External download url if not directly uploaded to Hangar */
            externalUrl?: string;
            fileInfo?: components["schemas"]["FileInfo"];
        };
        PluginDependency: {
            /**
             * @description External url to download the dependency from if not a Hangar project, else null
             * @example https://papermc.io/downloads
             */
            externalUrl?: string;
            /**
             * @description Name of the plugin dependency. For non-external dependencies, this should be the Hangar project name
             * @example Maintenance
             */
            name?: string;
            /** @description Platform the dependency runs on */
            platform?: components["schemas"]["Platform"];
            /**
             * Format: int64
             * @description Project ID of the dependency. Only for non-external dependencies
             * @example 1
             */
            projectId?: number;
            /** @description Whether the dependency is required for the plugin to function */
            required?: boolean;
        };
        PossibleProjectOwner: {
            /** Format: int64 */
            id?: number;
            name?: string;
            organization?: boolean;
            /** Format: int64 */
            userId?: number;
        };
        Project: {
            /** @description The url to the project's icon */
            avatarUrl?: string;
            /** @description The category of the project */
            category?: components["schemas"]["Category"];
            /** Format: date-time */
            createdAt?: string;
            /** @description The short description of the project */
            description?: string;
            /**
             * Format: int64
             * @description The internal id of the project
             */
            id?: number;
            /**
             * Format: date-time
             * @description The last time the project was updated
             */
            lastUpdated?: string;
            /** @description The content of the main page */
            mainPageContent?: string;
            /** @description The names of the members of the project */
            memberNames?: string[];
            /** @description The unique name of the project */
            name?: string;
            /** @description The namespace of the project */
            namespace?: components["schemas"]["ProjectNamespace"];
            /**
             * Format: date-time
             * @description The time the project's first version was published
             */
            publishedAt?: string | null;
            /** @description The settings of the project */
            settings?: components["schemas"]["ProjectSettings"];
            /** @description Stats of the project */
            stats?: components["schemas"]["ProjectStats"];
            /** @description The platforms and versions the project supports */
            supportedPlatforms?: {
                [key: string]: string[];
            };
            /** @description Information about your interactions with the project */
            userActions?: components["schemas"]["UserActions"];
            /** @description The visibility of the project */
            visibility?: components["schemas"]["Visibility"];
        };
        ProjectApprovals: {
            needsApproval?: components["schemas"]["HangarProjectApproval"][];
            waitingProjects?: components["schemas"]["HangarProjectApproval"][];
        };
        ProjectChannel: {
            color?: components["schemas"]["Color"];
            /** Format: date-time */
            createdAt?: string;
            description?: string;
            flags?: components["schemas"]["ChannelFlag"][];
            name?: string;
        };
        ProjectCompact: {
            /** @description The url to the project's icon */
            avatarUrl?: string;
            /** @description The category of the project */
            category?: components["schemas"]["Category"];
            /** Format: date-time */
            createdAt?: string;
            /** @description The short description of the project */
            description?: string;
            /**
             * Format: int64
             * @description The internal id of the project
             */
            id?: number;
            /**
             * Format: date-time
             * @description The last time the project was updated
             */
            lastUpdated?: string;
            /** @description The unique name of the project */
            name?: string;
            /** @description The namespace of the project */
            namespace?: components["schemas"]["ProjectNamespace"];
            /** @description Stats of the project */
            stats?: components["schemas"]["ProjectStats"];
            /** @description The visibility of the project */
            visibility?: components["schemas"]["Visibility"];
        };
        ProjectDonationSettings: {
            enable?: boolean;
            subject?: string;
        };
        ProjectLicense: {
            name?: string;
            type?: string;
            url?: string;
        };
        ProjectLinksForm: {
            links: components["schemas"]["LinkSection"][];
        };
        ProjectMember: {
            name: string;
            permissions?: components["schemas"]["NamedPermission"][];
            title?: string;
        };
        ProjectNamespace: {
            owner?: string;
            /**
             * @description The unique name of a project
             * @example Maintenance
             */
            slug?: string;
        };
        ProjectOwner: {
            /** Format: int64 */
            id?: number;
            name?: string;
            organization?: boolean;
            /** Format: int64 */
            userId?: number;
        };
        ProjectPageTable: {
            contents?: string;
            /** Format: date-time */
            createdAt?: string;
            deletable?: boolean;
            homepage?: boolean;
            /** Format: int64 */
            id?: number;
            name?: string;
            slug?: string;
        };
        ProjectRoleTable: {
            accepted?: boolean;
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            id?: number;
            owner?: boolean;
            permissions?: components["schemas"]["NamedPermission"][];
            /** Format: int64 */
            principalId?: number;
            title?: string;
            /** Format: int64 */
            userId?: number;
        };
        ProjectSettings: {
            /** @deprecated */
            donation?: components["schemas"]["ProjectDonationSettings"];
            keywords: string[];
            license?: components["schemas"]["ProjectLicense"];
            links: components["schemas"]["LinkSection"][];
            sponsors?: string;
            tags: components["schemas"]["Tag"][];
            /** @description Whether the project is reachable by link but left out of search, the homepage and profiles */
            unlisted?: boolean;
        };
        ProjectSettingsForm: {
            category: components["schemas"]["Category"];
            description: string;
            settings?: components["schemas"]["ProjectSettings"];
        };
        ProjectStats: {
            /** Format: int64 */
            downloads?: number;
            /** Format: int64 */
            recentDownloads?: number;
            /** Format: int64 */
            recentViews?: number;
            /** Format: int64 */
            stars?: number;
            /** Format: int64 */
            views?: number;
            /** Format: int64 */
            watchers?: number;
        };
        ProjectValidations: {
            channels?: components["schemas"]["Validation"];
            desc?: components["schemas"]["Validation"];
            keywordName?: components["schemas"]["Validation"];
            keywords?: components["schemas"]["Validation"];
            license?: components["schemas"]["Validation"];
            /** Format: int32 */
            maxChannelCount?: number;
            /** Format: int32 */
            maxFileSize?: number;
            /** Format: int32 */
            maxPageCount?: number;
            name?: components["schemas"]["Validation"];
            pageContent?: components["schemas"]["Validation"];
            pageName?: components["schemas"]["Validation"];
            sponsorsContent?: components["schemas"]["Validation"];
        };
        /** @enum {string} */
        Prompt: "CHANGE_AVATAR";
        PromptData: {
            messageKey?: string;
            name?: string;
            titleKey?: string;
        };
        RenameRequest: {
            displayName?: string;
            id?: string;
        };
        ReportNotificationForm: {
            content?: string;
            toReporter?: boolean;
            warning?: boolean;
        };
        ResetForm: {
            code?: string;
            email: string;
            password?: string;
        };
        Review: {
            lastAction?: components["schemas"]["ReviewAction"];
            /** Format: date-time */
            reviewEnded?: string;
            /** Format: date-time */
            reviewStarted?: string;
            reviewerName?: string;
        };
        /** @enum {string} */
        ReviewAction: "START" | "MESSAGE" | "STOP" | "REOPEN" | "APPROVE" | "PARTIALLY_APPROVE" | "UNDO_APPROVAL";
        ReviewActivity: {
            /** Format: date-time */
            endedAt?: string;
            namespace?: components["schemas"]["ProjectNamespace"];
            platforms?: components["schemas"]["Platform"][];
            versionString?: string;
        };
        ReviewMessage: {
            args: Record<string, never>;
            message: string;
        };
        ReviewQueue: {
            notStarted?: components["schemas"]["HangarReviewQueueEntry"][];
            underReview?: components["schemas"]["HangarReviewQueueEntry"][];
        };
        /** @enum {string} */
        ReviewState: "unreviewed" | "reviewed" | "under_review" | "partially_reviewed";
        RoleData: {
            assignable?: boolean;
            color?: string;
            permissions?: string;
            /** Format: int32 */
            rank?: number;
            roleCategory?: string;
            /** Format: int64 */
            roleId?: number;
            title?: string;
            value?: string;
        };
        ScopableProject: {
            avatarUrl?: string;
            name?: string;
            namespace?: components["schemas"]["ProjectNamespace"];
        };
        Security: {
            oauthProviders?: string[];
            safeDownloadHosts?: string[];
        };
        SettingsResponse: {
            authenticators?: components["schemas"]["Authenticator"][];
            /** Format: date-time */
            deletionScheduledFor?: string;
            emailConfirmed?: boolean;
            emailPending?: boolean;
            hasBackupCodes?: boolean;
            hasPassword?: boolean;
            hasTotp?: boolean;
            oauthConnections?: components["schemas"]["OAuthConnection"][];
            /** Format: int64 */
            ownedOrganizationCount?: number;
            /** Format: int64 */
            ownedProjectCount?: number;
        };
        SignupForm: {
            captcha?: string;
            email?: string;
            password?: string;
            tos?: boolean;
            username?: string;
        };
        StatsSummary: {
            platformDownloads?: components["schemas"]["PlatformDownloads"][];
            topProjects?: components["schemas"]["TopProject"][];
            totals?: components["schemas"]["StatsTotals"];
        };
        StatsTotals: {
            /** Format: int64 */
            downloads?: number;
            /** Format: int64 */
            openFlags?: number;
            /** Format: int64 */
            pendingReviews?: number;
            /** Format: int64 */
            projects?: number;
            /** Format: int64 */
            users?: number;
            /** Format: int64 */
            versions?: number;
            /** Format: int64 */
            views?: number;
        };
        StreamingResponseBody: unknown;
        /** @description The path and new contents of the page */
        StringContent: {
            /** @description A non-null, non-empty string */
            content: string;
        };
        /** @enum {string} */
        Tag: "ADDON" | "LIBRARY" | "SUPPORTS_FOLIA";
        TopProject: {
            /** Format: int64 */
            downloads?: number;
            namespace?: components["schemas"]["ProjectNamespace"];
            /** Format: int64 */
            views?: number;
        };
        TotpForm: {
            code?: string;
            secret?: string;
        };
        TotpSetupResponse: {
            qrCode?: string;
            secret?: string;
        };
        /** @enum {string} */
        Type: "CHANNEL" | "VERSION";
        UnhealthyProject: {
            /** Format: date-time */
            lastUpdated?: string;
            namespace?: components["schemas"]["ProjectNamespace"];
            visibility?: components["schemas"]["Visibility"];
        };
        UnreadCount: {
            /** Format: int64 */
            invites?: number;
            /** Format: int64 */
            notifications?: number;
        };
        UpdatePlatformVersions: {
            platform: components["schemas"]["Platform"];
            versions?: string[];
        };
        UpdatePlatformVersionsForm: {
            empty?: boolean;
        } & {
            [key: string]: string[];
        };
        UpdatePluginDependencies: {
            platform: components["schemas"]["Platform"];
            pluginDependencies?: {
                [key: string]: components["schemas"]["PluginDependency"];
            };
        };
        /** @description A version that has been uploaded */
        UploadedVersion: {
            /**
             * @description URL of the uploaded version
             * @example https://hangar.papermc.io/PaperMC/Debuggery/versions/1.0.0
             */
            url?: string;
        };
        User: {
            avatarUrl?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: int64 */
            id?: number;
            isOrganization?: boolean;
            locked?: boolean;
            name?: string;
            nameHistory?: components["schemas"]["UserNameChange"][] | null;
            /** Format: int64 */
            projectCount?: number;
            roles?: number[];
            socials?: components["schemas"]["JsonNode"];
            tagline?: string;
        };
        UserActions: {
            flagged?: boolean;
            starred?: boolean;
            watching?: boolean;
        };
        UserNameChange: {
            /** Format: date-time */
            date?: string;
            newName?: string;
            oldName?: string;
        };
        UserPermissions: {
            permissionBinString?: string;
            permissions?: components["schemas"]["NamedPermission"][];
            type?: components["schemas"]["PermissionType"];
        };
        UserProfileSettings: {
            socials?: {
                [key: string]: string;
            };
            tagline?: string;
        };
        UserSettings: {
            language?: string;
            theme?: string;
        };
        UserTable: {
            avatarUrl?: string;
            /** Format: date-time */
            createdAt?: string;
            emailVerified?: boolean;
            /** Format: int64 */
            id?: number;
            language?: string;
            locked?: boolean;
            name?: string;
            organization?: boolean;
            readPrompts?: number[];
            socials?: components["schemas"]["JsonNode"];
            tagline?: string;
            theme?: string;
            /** Format: int64 */
            userId?: number;
            /** Format: uuid */
            uuid?: string;
        };
        Validation: {
            /** Format: int32 */
            max?: number;
            /** Format: int32 */
            min?: number;
            regex?: string;
        };
        Validations: {
            /** Format: int32 */
            maxOrgCount?: number;
            org?: components["schemas"]["Validation"];
            project?: components["schemas"]["ProjectValidations"];
            urlRegex?: string;
            userTagline?: components["schemas"]["Validation"];
            version?: components["schemas"]["Validation"];
        };
        Version: {
            author?: string;
            channel?: components["schemas"]["ProjectChannel"];
            /** Format: date-time */
            createdAt?: string;
            description?: string;
            downloads?: {
                [key: string]: components["schemas"]["PlatformVersionDownload"];
            };
            /** Format: int64 */
            id?: number;
            memberNames?: string[];
            name?: string;
            pinnedStatus?: components["schemas"]["PinnedStatus"];
            platformDependencies?: {
                [key: string]: string[];
            };
            platformDependenciesFormatted?: {
                [key: string]: string[];
            };
            pluginDependencies?: {
                [key: string]: components["schemas"]["PluginDependency"][];
            };
            /** Format: int64 */
            projectId?: number;
            reviewState?: components["schemas"]["ReviewState"];
            stats?: components["schemas"]["VersionStats"];
            visibility?: components["schemas"]["Visibility"];
        };
        VersionInfo: {
            behind?: string;
            commit?: string;
            commitShort?: string;
            committer?: string;
            message?: string;
            tag?: string;
            time?: string;
            version?: string;
        };
        VersionStats: {
            platformDownloads?: {
                [key: string]: number;
            };
            /** Format: int64 */
            totalDownloads?: number;
        };
        /** @description Version data. See the VersionUpload schema for more info */
        VersionUpload: {
            /**
             * @description Channel of the version to be published under
             * @example Release
             */
            channel: string;
            description?: string;
            files: components["schemas"]["MultipartFileOrUrl"][];
            /**
             * @description Map of platforms and their versions this version runs on
             * @example {PAPER: ["1.12", "1.16-1.18.2", "1.20.x"]}
             */
            platformDependencies: {
                [key: string]: string[];
            };
            /** @description Map of each platform's plugin dependencies */
            pluginDependencies?: {
                [key: string]: components["schemas"]["PluginDependency"][];
            };
            /**
             * @description Version string of the version to be published
             * @example 1.0.0-SNAPSHOT+1
             */
            version: string;
        };
        /**
         * @description The visibility of a project or version
         * @example PUBLIC
         * @enum {string}
         */
        Visibility: "public" | "new" | "needsChanges" | "needsApproval" | "softDelete";
        VisibilityChangeForm: {
            comment?: string;
            visibility: components["schemas"]["Visibility"];
        };
        VisibilityData: {
            canChangeTo?: boolean;
            cssClass?: string;
            name?: string;
            showModal?: boolean;
            title?: string;
        };
        Webhook: {
            canceledBy?: string;
            details?: components["schemas"]["Details"];
            duration?: string;
            enqueuedAt?: string;
            error?: components["schemas"]["Error"];
            /** Format: date-time */
            finishedAt?: string;
            indexUid?: string;
            /** Format: date-time */
            startedAt?: string;
            status?: string;
            type?: string;
            uid?: string;
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
    authenticate: {
        parameters: {
            query: {
                /** @description JWT */
                apiKey: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiSession"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiSession"];
                };
            };
            /** @description Api key missing or invalid */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiSession"];
                };
            };
        };
    };
    getAuthors: {
        parameters: {
            query: {
                /** @description The search query */
                query: string;
                /** @description Used to sort the result */
                sort?: "name" | "createdAt" | "projectCount";
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
        };
    };
    getKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The keys */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKey"][];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKey"][];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKey"][];
                };
            };
        };
    };
    createKey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAPIKeyForm"];
            };
        };
        responses: {
            /** @description Key created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
        };
    };
    deleteKey: {
        parameters: {
            query: {
                /** @description The name of the key to delete */
                name: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Key deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    editPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id of the project to change the page for */
                project: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PageEditForm"];
            };
        };
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    editMainPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id of the project to change the page for */
                project: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StringContent"];
            };
        };
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getMainPage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id of the project to return the page for */
                project: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
        };
    };
    getPage: {
        parameters: {
            query: {
                /** @description The path of the page */
                path: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return the page for */
                project: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
        };
    };
    showPermissions: {
        parameters: {
            query?: {
                /**
                 * @deprecated
                 * @description Deprecated alias for `project`
                 */
                slug?: string;
                /** @description The id or name of the organization to check permissions in. Must not be used together with `project` */
                organization?: string;
                /** @description The id or slug of the project to check permissions in. Must not be used together with `organization` */
                project?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserPermissions"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserPermissions"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserPermissions"];
                };
            };
        };
    };
    hasAll: {
        parameters: {
            query: {
                /** @description The permissions to check */
                permissions: components["schemas"]["NamedPermission"][];
                /**
                 * @deprecated
                 * @description Deprecated alias for `project`
                 */
                slug?: string;
                /** @description The id or name of the organization to check permissions in. Must not be used together with `slug` */
                organization?: string;
                /** @description The id or slug of the project to check permissions in. Must not be used together with `organization` */
                project?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PermissionCheck"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PermissionCheck"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PermissionCheck"];
                };
            };
        };
    };
    hasAny: {
        parameters: {
            query: {
                /** @description The permissions to check */
                permissions: components["schemas"]["NamedPermission"][];
                /**
                 * @deprecated
                 * @description Deprecated alias for `project`
                 */
                slug?: string;
                /** @description The id or name of the organization to check permissions in. Must not be used together with `project` */
                organization?: string;
                /** @description The id or slug of the project to check permissions in. Must not be used together with `organization` */
                project?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PermissionCheck"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PermissionCheck"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PermissionCheck"];
                };
            };
        };
    };
    getPlatformVersions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The platform to get versions for */
                platform: components["schemas"]["Platform"];
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
                    "*/*": components["schemas"]["PlatformVersion"][];
                };
            };
        };
    };
    getProjects: {
        parameters: {
            query?: {
                /**
                 * @deprecated
                 * @description Whether to prioritize the project with an exact name match if present
                 */
                prioritizeExactMatch?: boolean;
                /** @description Used to sort the result */
                sort?: "views" | "downloads" | "newest" | "stars" | "updated" | "recent_downloads" | "recent_views" | "slug";
                /** @description A category to filter for */
                category?: string;
                /** @description A platform to filter for */
                platform?: string;
                /** @description The author of the project */
                owner?: string;
                /**
                 * @deprecated
                 * @description Deprecated: Use 'query' instead
                 */
                q?: string;
                /** @description The query to use when searching */
                query?: string;
                /** @description A license to filter for */
                license?: string;
                /** @description A platform version to filter for */
                version?: string;
                /** @description A tag to filter for */
                tag?: string;
                /** @description The member of the project */
                member?: string;
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProject"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProject"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProject"];
                };
            };
        };
    };
    getProject: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id or id of the project to return */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
        };
    };
    latestVersion: {
        parameters: {
            query: {
                /** @description The channel to return the latest version for */
                channel: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return the latest version for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
        };
    };
    latestReleaseVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id of the project to return the latest version for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
        };
    };
    getProjectMembers: {
        parameters: {
            query?: {
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return members for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectMember"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectMember"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectMember"];
                };
            };
        };
    };
    getProjectStargazers: {
        parameters: {
            query?: {
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return stargazers for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
        };
    };
    showProjectStats: {
        parameters: {
            query: {
                /** @description The first date to include in the result */
                fromDate: string;
                /** @description The last date to include in the result */
                toDate: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return stats for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["DayProjectStats"];
                    };
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["DayProjectStats"];
                    };
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["DayProjectStats"];
                    };
                };
            };
        };
    };
    uploadVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id of the project to return versions for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "multipart/form-data": {
                    /** @description The version files in order of selected platforms, if any */
                    files?: string[];
                    versionUpload: components["schemas"]["VersionUpload"];
                };
            };
        };
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadedVersion"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadedVersion"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadedVersion"];
                };
            };
        };
    };
    listVersions: {
        parameters: {
            query?: {
                /** @description Whether to include hidden-by-default channels in the result, defaults to true */
                includeHiddenChannels?: boolean;
                /** @description A name of a version channel to filter for */
                channel?: string;
                /** @description A platform name to filter for */
                platform?: string;
                /** @description A platform version to filter for */
                platformVersion?: string;
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return versions for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultVersion"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultVersion"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultVersion"];
                };
            };
        };
    };
    showVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id of the project to return the version for */
                slugOrId: string;
                /** @description The name or id of the version to return */
                nameOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Version"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Version"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Version"];
                };
            };
        };
    };
    showVersionStats: {
        parameters: {
            query: {
                /** @description The first date to include in the result */
                fromDate: string;
                /** @description The last date to include in the result */
                toDate: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return stats for */
                slugOrId: string;
                /** @description The version to return the stats for */
                nameOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["VersionStats"];
                    };
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["VersionStats"];
                    };
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["VersionStats"];
                    };
                };
            };
        };
    };
    downloadVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The slug or id of the project to download the version from */
                slugOrId: string;
                /** @description The name of the version to download */
                nameOrId: string;
                /** @description The platform of the version to download */
                platform: components["schemas"]["Platform"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Version has an external download url */
            303: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Version doesn't have a file attached to it */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
        };
    };
    getProjectWatchers: {
        parameters: {
            query?: {
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path: {
                /** @description The slug or id of the project to return watchers for */
                slugOrId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
        };
    };
    getStaff: {
        parameters: {
            query: {
                /** @description The search query */
                query: string;
                /** @description Used to sort the result */
                sort?: "name" | "createdAt" | "roles";
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
        };
    };
    showUsers: {
        parameters: {
            query: {
                /** @description The search query */
                query: string;
                /** @description Used to sort the result */
                sort?: "name" | "createdAt" | "projectCount" | "locked" | "org" | "roles";
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultUser"];
                };
            };
        };
    };
    getUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The name or id of the user to return */
                user: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
        };
    };
    getUserPinnedProjects: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The name or id of the user to return pinned projects for */
                user: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectCompact"][];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectCompact"][];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectCompact"][];
                };
            };
        };
    };
    showStarred: {
        parameters: {
            query?: {
                /** @description Used to sort the result */
                sort?: "views" | "downloads" | "newest" | "stars" | "updated" | "recent_downloads" | "recent_views" | "slug";
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path: {
                /** @description The name or id of the user to return starred projects for */
                user: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectCompact"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectCompact"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectCompact"];
                };
            };
        };
    };
    getUserWatching: {
        parameters: {
            query?: {
                /** @description Used to sort the result */
                sort?: "views" | "downloads" | "newest" | "stars" | "updated" | "recent_downloads" | "recent_views" | "slug";
                /** @description The maximum amount of items to return */
                limit?: string;
                /** @description Where to start searching */
                offset?: string;
            };
            header?: never;
            path: {
                /** @description The name or id of the user to return watched projects for */
                user: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectCompact"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectCompact"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaginatedResultProjectCompact"];
                };
            };
        };
    };
    projectByVersionHash: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The SHA-256 hash of the version */
                hash: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
        };
    };
    showVersionById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The id of the version to return */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Version"];
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Version"];
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Version"];
                };
            };
        };
    };
    showVersionStatsById: {
        parameters: {
            query: {
                /** @description The first date to include in the result */
                fromDate: string;
                /** @description The last date to include in the result */
                toDate: string;
            };
            header?: never;
            path: {
                /** @description The id of version to return the stats for */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["VersionStats"];
                    };
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["VersionStats"];
                    };
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: components["schemas"]["VersionStats"];
                    };
                };
            };
        };
    };
    downloadVersionById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The id of the version to download */
                id: string;
                /** @description The platform of the version to download */
                platform: components["schemas"]["Platform"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ok */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Version has an external download url */
            303: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Version doesn't have a file attached to it */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Api session missing, invalid or expired */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
            /** @description Not enough permissions to use this endpoint */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": Record<string, never>;
                };
            };
        };
    };
}
