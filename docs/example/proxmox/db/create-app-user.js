// create-app-user.js — add an application database + scoped user to an EXISTING
// MongoDB. Use this to give a SECOND, independent instance (e.g. a "dev" app
// alongside "production") its own database + least-privilege user WITHOUT
// reinstalling MongoDB or touching the first instance's data.
//
// The admin (root) user already exists — db/setup-db.in-ct.sh created it during
// the first setup, so you do NOT need this for the very first database (that one
// is created for you). Run this inside the DB CT, authenticating as admin, with
// the new instance's values in the environment:
//
//   ADMIN_DB_PASS=... APP_DB_USER=devuser APP_DB_NAME=open_poll_dev APP_DB_PASS=... \
//     mongosh "mongodb://127.0.0.1:27017/admin" --file create-app-user.js
//
// Then point that instance's app config (mongo_url / mongo_db_name) at the new
// database. Passwords come from the environment so none are written into this file.

const adminPass = process.env.ADMIN_DB_PASS;
const appUser   = process.env.APP_DB_USER;
const appName   = process.env.APP_DB_NAME;
const appPass   = process.env.APP_DB_PASS;

if (!adminPass || !appUser || !appName || !appPass) {
  print('FATAL: set ADMIN_DB_PASS, APP_DB_USER, APP_DB_NAME and APP_DB_PASS in the environment.');
  quit(1);
}

try {
  db = db.getSiblingDB('admin');
  if (!db.auth('admin', adminPass)) { throw new Error('admin authentication failed'); }

  // Least-privilege application user, scoped to its own database.
  const target = db.getSiblingDB(appName);
  target.createUser({
    user: appUser,
    pwd:  appPass,
    roles: [{ role: 'readWrite', db: appName }],
  });
  if (!target.getUser(appUser)) { throw new Error('app user missing after creation'); }

  print('OK: created user ' + appUser + ' on database ' + appName + '.');
  print('App connection string (set this instance\'s mongo_url):');
  print('  mongodb://' + appUser + ':<password>@<DB_CT_IP>:27017/' + appName + '?authSource=' + appName);
} catch (e) {
  print('FATAL: ' + e);
  quit(1);
}
