const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server.js');

const tempDir = path.join(__dirname, 'tmp-data');
const tempDataFile = path.join(tempDir, 'users.json');

function makeServer() {
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(tempDataFile, JSON.stringify({ users: [] }, null, 2), 'utf8');

  const { app } = createApp({
    dataFile: tempDataFile,
    adminKey: 'test-admin-key',
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('signup stores a user and admin can list all users', async () => {
  const { server, baseUrl } = await makeServer();

  try {
    const signupResponse = await fetch(`${baseUrl}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'secret123',
        name: 'Alice Example',
        username: 'alice',
      }),
    });

    assert.equal(signupResponse.status, 201);
    const signupBody = await signupResponse.json();
    assert.equal(signupBody.user.email, 'alice@example.com');

    const adminResponse = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { 'X-Admin-Key': 'test-admin-key' },
    });

    assert.equal(adminResponse.status, 200);
    const adminBody = await adminResponse.json();
    assert.equal(adminBody.count, 1);
    assert.equal(adminBody.users[0].email, 'alice@example.com');
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
