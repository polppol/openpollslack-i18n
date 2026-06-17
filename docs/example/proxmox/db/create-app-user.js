// Manual user creation for MongoDB (alternative to setup-db.in-ct.sh doing it).
//
// Use this only if you are setting MongoDB up by hand. Run it over the
// localhost exception on the DB container BEFORE any users exist:
//
//   mongosh "mongodb://127.0.0.1:27017/admin" --file create-app-user.js
//
// Change BOTH passwords below first. The app password must match the one in
// the application's mongo_url (app/default.json.example).

const ADMIN_PASS = 'REPLACE_WITH_ADMIN_PASSWORD';
const APP_PASS   = 'REPLACE_WITH_APP_DB_PASSWORD';

// 1) Cluster admin (root) — used for backups and maintenance.
db = db.getSiblingDB('admin');
db.createUser({
  user: 'admin',
  pwd:  ADMIN_PASS,
  roles: [{ role: 'root', db: 'admin' }],
});

// The localhost exception only allows the FIRST user, so authenticate now.
db.auth('admin', ADMIN_PASS);

// 2) Application user — least privilege, scoped to the open_poll database.
db.getSiblingDB('open_poll').createUser({
  user: 'openpoll',
  pwd:  APP_PASS,
  roles: [{ role: 'readWrite', db: 'open_poll' }],
});

print('Created users: admin (root) and openpoll (readWrite on open_poll).');
print('App connection string:');
print('  mongodb://openpoll:<password>@<DB_CT_IP>:27017/open_poll?authSource=open_poll');
