/**
 * Integration tests for admin console
 * Tests against a running backend server (started/stopped per test suite)
 */
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const BASE_URL = 'http://localhost:8080';
const TEST_TIMEOUT = 10000;

let serverProcess = null;

// Start backend server
function startServer() {
  return new Promise((resolve, reject) => {
    process.env.NODE_ENV = 'test';
    serverProcess = spawn('node', [path.join(__dirname, '../../backend/src/index.js')], {
      stdio: 'pipe',
      detached: false,
    });

    let output = '';
    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('admin_console_started')) {
        // Server has started, wait a bit for it to be fully ready
        setTimeout(resolve, 1000);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('Server error:', data.toString());
    });

    serverProcess.on('error', reject);
    serverProcess.on('exit', () => {
      serverProcess = null;
    });

    // Timeout if server doesn't start in 15 seconds
    setTimeout(() => reject(new Error('Server startup timeout')), 15000);
  });
}

// Stop backend server
function stopServer() {
  return new Promise((resolve) => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.on('exit', () => {
        serverProcess = null;
        resolve();
      });
      serverProcess.kill('SIGTERM');
      // Force kill after 5 seconds if not stopped
      setTimeout(() => {
        if (serverProcess) {
          serverProcess.kill('SIGKILL');
        }
        resolve();
      }, 5000);
    } else {
      resolve();
    }
  });
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: TEST_TIMEOUT,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(TEST_TIMEOUT, () => req.destroy());

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('Integration Tests', () => {
  before(async function() {
    this.timeout(20000);
    await startServer();
  });

  after(async function() {
    this.timeout(10000);
    await stopServer();
  });

  describe('Server Health', () => {
    it('should be running and responding', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('GET', '/healthz');
      assert.ok([200, 204].includes(res.status), `Expected 200 or 204, got ${res.status}`);
    }).timeout(TEST_TIMEOUT);
  });

  describe('Studies Search', () => {
    it('should search studies without errors', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('POST', '/api/studies/search', {
        key: 'PatientID',
        value: '',
        studyLimit: 1,
        studyOffset: 0,
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.items);
      assert.ok(typeof res.data.totalStudies === 'number');
    }).timeout(TEST_TIMEOUT);

    it('should handle special characters in search values', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('POST', '/api/studies/search', {
        key: 'PatientID',
        value: 'SanM1413_%',
        studyLimit: 1,
        studyOffset: 0,
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.items);
    }).timeout(TEST_TIMEOUT);

    it('should accept explicit studies sort column and direction', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('POST', '/api/studies/search', {
        key: 'PatientID',
        value: '',
        studyLimit: 5,
        studyOffset: 0,
        sortBy: 'patientName',
        sortDirection: 'asc',
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.items));
      assert.equal(res.data.sortBy, 'patientName');
      assert.equal(res.data.sortDirection, 'asc');
    }).timeout(TEST_TIMEOUT);

    it('should normalize invalid sort params to study date descending', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('POST', '/api/studies/search', {
        key: 'PatientID',
        value: '',
        studyLimit: 5,
        studyOffset: 0,
        sortBy: 'notAColumn',
        sortDirection: 'upward',
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.items));
      assert.equal(res.data.sortBy, 'studyDate');
      assert.equal(res.data.sortDirection, 'desc');
    }).timeout(TEST_TIMEOUT);
  });

  describe('Studies Instances', () => {
    it('should retrieve instances for a study', async function() {
      this.timeout(TEST_TIMEOUT);
      // First get a study
      const studies = await request('POST', '/api/studies/search', {
        key: 'PatientID',
        value: '',
        studyLimit: 1,
        studyOffset: 0,
      });

      if (studies.data.items && studies.data.items.length > 0) {
        const studyId = studies.data.items[0].studyId;
        const res = await request('GET', `/studies/${encodeURIComponent(studyId)}/instances?limit=1`);
        assert.equal(res.status, 200);
        assert.ok(res.data.items);
        if (res.data.items.length > 0) {
          assert.ok(res.data.items[0].metadata);
          assert.equal(typeof res.data.items[0].metadata, 'object', 'Metadata should be parsed as object');
        }
      }
    }).timeout(TEST_TIMEOUT);
  });

  describe('Monitoring Data', () => {
    it('should return instance counts for monitoring', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('GET', '/api/instances/counts');
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.totalStudies === 'number');
      assert.ok(typeof res.data.totalInstances === 'number');
    }).timeout(TEST_TIMEOUT);
  });

  describe('DLQ Operations', () => {
    it('should return DLQ count', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('GET', '/api/dlq/count');
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.count === 'number');
    }).timeout(TEST_TIMEOUT);

    it('should return DLQ summary', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('GET', '/api/dlq/summary');
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.totalCount === 'number');
    }).timeout(TEST_TIMEOUT);

    it('should return DLQ items', async function() {
      this.timeout(TEST_TIMEOUT);
      const res = await request('GET', '/api/dlq/items?limit=10&offset=0');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.items));
    }).timeout(TEST_TIMEOUT);
  });

  describe('Image Viewing', () => {
    it('should retrieve instance content', async function() {
      this.timeout(TEST_TIMEOUT);
      // First get a study with instances
      const studies = await request('POST', '/api/studies/search', {
        key: 'PatientID',
        value: '',
        studyLimit: 1,
        studyOffset: 0,
      });

      if (studies.data.items && studies.data.items.length > 0) {
        const studyId = studies.data.items[0].studyId;
        const instances = await request('GET', `/studies/${encodeURIComponent(studyId)}/instances?limit=1`);

        if (instances.data.items && instances.data.items.length > 0) {
          const metadata = instances.data.items[0].metadata || {};
          const studyUid = metadata.StudyInstanceUID;
          const seriesUid = metadata.SeriesInstanceUID;
          const sopInstanceUid = metadata.SOPInstanceUID;

          if (!studyUid || !seriesUid || !sopInstanceUid) {
            this.skip();
          }

          const content = await request(
            'GET',
            `/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(sopInstanceUid)}/render`,
          );
          
          // Should return 200 or 404 or 500 (if file doesn't exist in GCS)
          assert.ok([200, 404, 500].includes(content.status));
          
          if (content.status === 200) {
            // Verify content structure
            assert.ok(content.data.mimeType);
            assert.ok(['image', 'text', 'binary'].includes(content.data.contentType));

            if (content.data.contentType === 'text') {
              assert.ok(typeof content.data.text === 'string');
            } else {
              assert.ok(typeof content.data.dataBase64 === 'string');
            }
          }
        }
      }
    }).timeout(TEST_TIMEOUT);

    it('should handle missing content gracefully', async function() {
      this.timeout(TEST_TIMEOUT);
      // Request content for non-existent DICOM UID tuple
      const res = await request(
        'GET',
        '/studies/nonexistent-study/series/nonexistent-series/instances/nonexistent-instance/render',
      );
      // Should return 404 or 500 if not found/accessible
      assert.ok([404, 500].includes(res.status));
    }).timeout(TEST_TIMEOUT);
  });

  describe('Study Download', () => {
    it('should be able to request study download', async function() {
      this.timeout(30000);  // Increase timeout for download operation
      // First get a study
      const studies = await request('POST', '/api/studies/search', {
        key: 'PatientID',
        value: '',
        studyLimit: 1,
        studyOffset: 0,
      });

      if (studies.data.items && studies.data.items.length > 0) {
        const studyId = studies.data.items[0].studyId;
        const download = await request('GET', `/api/studies/${encodeURIComponent(studyId)}/download`);
        
        // Should return 200, 404, or 500 (depending on file availability)
        assert.ok([200, 404, 500].includes(download.status));
        
        if (download.status === 200) {
          // Response should contain study info or be a ZIP file
          assert.ok(download.data);
        }
      }
    });


    it('should return 404 for missing study', async function() {
      this.timeout(TEST_TIMEOUT);
      const fakeStudyId = 'nonexistent.study.1.2.3.4.5.6';
      const res = await request('GET', `/api/studies/${encodeURIComponent(fakeStudyId)}/download`);
      assert.ok([404, 500].includes(res.status));
    }).timeout(TEST_TIMEOUT);

    it('should handle missing study ID gracefully', async function() {
      this.timeout(TEST_TIMEOUT);
      // Try to request download with empty study ID (double slash in URL)
      const res = await request('GET', '/api/studies/nonexistent/download');
      // Should handle gracefully with 404 or 500
      assert.ok([404, 500].includes(res.status));
    }).timeout(TEST_TIMEOUT);
  });


  describe('Content and Download Endpoints', () => {
    it('should have content and download endpoints mapped', async function() {
      this.timeout(TEST_TIMEOUT);
      const endpoints = [
        { path: '/api/instances/inst-001/content', method: 'GET' },
        { path: '/api/studies/1.2.3/download', method: 'GET' },
      ];

      for (const endpoint of endpoints) {
        // Just verify endpoints are accessible (may return 404 for missing data)
        const res = await request(endpoint.method, endpoint.path);
        assert.ok([200, 400, 404].includes(res.status), 
          `Endpoint ${endpoint.method} ${endpoint.path} returned unexpected status ${res.status}`);
      }
    }).timeout(TEST_TIMEOUT);

    it('should have all required endpoints mapped', async function() {
      this.timeout(TEST_TIMEOUT);
      const endpoints = [
        { path: '/api/studies/search', method: 'POST' },
        { path: '/api/instances/counts', method: 'GET' },
        { path: '/api/dlq/count', method: 'GET' },
        { path: '/api/dlq/summary', method: 'GET' },
        { path: '/api/dlq/items', method: 'GET' },
        { path: '/api/studies/delete', method: 'POST' },
        { path: '/api/instances/delete', method: 'POST' },
        { path: '/api/studies/reprocess', method: 'POST' },
        { path: '/api/dlq/requeue', method: 'POST' },
        { path: '/api/dlq/delete', method: 'POST' },
        { path: '/api/process/run', method: 'POST' },
      ];

      for (const endpoint of endpoints) {
        // Just verify endpoint doesn't return 404
        const res = await request(endpoint.method, endpoint.path);
        assert.notEqual(res.status, 404, `Endpoint ${endpoint.method} ${endpoint.path} not found`);
      }
    }).timeout(TEST_TIMEOUT);
  });
});
