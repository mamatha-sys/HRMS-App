const Database = require('better-sqlite3');
const fs = require('fs');

const source = 'C:/Users/USER/Downloads/HRMS/HRMS-App/server/data/hrms.db';
const target = 'C:/Users/USER/Downloads/HRMS/HRMS-App/server/data/hrms-sync-temp.db';

if (!fs.existsSync(source)) {
    console.error('ERROR: Local hrms.db not found.');
    process.exit(1);
}

if (fs.existsSync(target)) {
    fs.unlinkSync(target);
}

console.log('Creating consistent SQLite snapshot...');

const db = new Database(source, { readonly: true });

try {
    db.backup(target)
        .then(() => {
            db.close();

            if (!fs.existsSync(target)) {
                console.error('ERROR: Snapshot was not created.');
                process.exit(1);
            }

            console.log('Snapshot created successfully.');
            console.log(`Snapshot: ${target}`);
            console.log(`Size: ${fs.statSync(target).size} bytes`);
        })
        .catch((err) => {
            db.close();
            console.error('SQLite backup failed:', err);
            process.exit(1);
        });
} catch (err) {
    db.close();
    console.error('SQLite backup failed:', err);
    process.exit(1);
}