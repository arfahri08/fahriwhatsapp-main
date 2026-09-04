"use strict";

module.exports = {
    apps: [
        {
            name: "a",
            script: "./index.js",
            cwd: __dirname,
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            restart_delay: 2000,
            min_uptime: "10s",
            max_restarts: 10,
            env: {
                // Fallback polling di dalam proses karena watcher daemon PM2
                // tidak konsisten menerima event SFTP pada beberapa Termux.
                INTERNAL_SOURCE_WATCH_ENABLED: "true",
                INTERNAL_SOURCE_WATCH_INTERVAL: "2",
                INTERNAL_SOURCE_WATCH_DEBOUNCE: "2",
                LANG: "en_US.UTF-8",
                LC_ALL: "en_US.UTF-8"
            },
            watch: [
                "index.js",
                "modules",
                ".env",
            ],
            watch_delay: 1500,
            // inotify di Android/Termux kadang tidak menerima event file yang
            // diganti lewat SFTP. Polling memastikan perubahan hasil upload
            // tetap terdeteksi tanpa perlu `pm2 restart` manual.
            watch_options: {
                usePolling: true,
                interval: 1000,
                binaryInterval: 1000,
                ignoreInitial: true,
                followSymlinks: false,
                awaitWriteFinish: {
                    stabilityThreshold: 1500,
                    pollInterval: 250,
                },
            },
            ignore_watch: [
                "node_modules",
                "auth",
                "data",
                "tmp",
                "temp",
                "\\.git",
                "\\.patch-backups",
                "\\.log$",
            ],
            time: true,
        },
    ],
};
