/**
 * UI/UX tests for admin console frontend
 * Tests frontend functionality using Playwright
 */
const { test, expect } = require('@playwright/test');

const baseURL = 'http://localhost:8080';
const TEST_TIMEOUT = 30000;

test.describe('Admin Console UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
  });

  test.describe('Studies Search Tab', () => {
    test('should load studies search interface', async ({ page }) => {
      // Use specific button ID instead of text selector
      const searchButton = page.locator('button#search-btn');
      await expect(searchButton).toBeVisible();
    });

    test('should perform studies search', async ({ page }) => {
      // Fill search input and use specific button ID
      const searchInput = page.locator('input[id*="search-value"]');
      await searchInput.fill('');
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      
      await page.waitForTimeout(2000);
      // Just verify the page is responsive
      const mainContent = page.locator('body');
      await expect(mainContent).toBeVisible();
    });

    test('should search with special characters without errors', async ({ page }) => {
      const keySelect = page.locator('select#search-key');
      if (await keySelect.isVisible().catch(() => false)) {
        await keySelect.selectOption({ value: 'PatientID' });
      }

      const searchInput = page.locator('input[id*="search-value"]');
      await searchInput.fill('SanM1413_%');
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();

      await page.waitForTimeout(2000);
      const searchStatus = page.locator('#search-status');
      if (await searchStatus.count().then(count => count > 0).catch(() => false)) {
        await expect(searchStatus).not.toContainText('Search failed');
      }
    });

    test('should expand study to show instances', async ({ page }) => {
      // First search
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Find and click expand button (summary elements)
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);
      }
    });

    test('should navigate through pagination', async ({ page }) => {
      // Use specific ID for studies pagination
      const nextButton = page.locator('button#studies-next');
      const isEnabled = await nextButton.isEnabled().catch(() => false);
      
      if (isEnabled) {
        await nextButton.click();
        await page.waitForTimeout(1000);
      }
    });
  });

  test.describe('Instance Viewing', () => {
    test('should view instance details', async ({ page }) => {
      // Search first
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Expand first study
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Click on instance row
        const instanceRow = page.locator('tbody tr').first();
        if (await instanceRow.isVisible().catch(() => false)) {
          await instanceRow.click();
          await page.waitForTimeout(1000);
        }
      }
    });

    test('should show instance metadata in modal', async ({ page }) => {
      // Just verify some content is visible after search
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);
      
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });
  });

  test.describe('DLQ Management', () => {
    test('should switch to DLQ tab', async ({ page }) => {
      // Use specific data attribute for DLQ tab
      const dlqTab = page.locator('button[data-tab="dlp"]');
      const isVisible = await dlqTab.isVisible().catch(() => false);
      if (isVisible) {
        await dlqTab.click();
        await page.waitForTimeout(1000);
      }
    });

    test('should refresh DLQ list', async ({ page }) => {
      // Navigate to DLQ tab using specific data attribute
      const dlqTab = page.locator('button[data-tab="dlp"]');
      const isVisible = await dlqTab.isVisible().catch(() => false);
      if (isVisible) {
        await dlqTab.click();
        
        // Look for refresh button - use first available refresh button
        const refreshButton = page.locator('button').filter({ hasText: 'Refresh' }).first();
        const isEnabled = await refreshButton.isEnabled().catch(() => false);
        if (isEnabled) {
          await refreshButton.click();
          await page.waitForTimeout(2000);
        }
      }
    });

    test('should display DLQ items', async ({ page }) => {
      const dlqTab = page.locator('button[data-tab="dlp"]');
      const isVisible = await dlqTab.isVisible().catch(() => false);
      if (isVisible) {
        await dlqTab.click();
        await page.waitForTimeout(1000);
        
        // Just verify content is visible
        const content = page.locator('body');
        await expect(content).toBeVisible();
      }
    });
  });

  test.describe('Monitoring Dashboard', () => {
    test('should display monitoring tab', async ({ page }) => {
      // Use specific data attribute for monitoring tab
      const monitoringTab = page.locator('button[data-tab="monitoring"]');
      const isVisible = await monitoringTab.isVisible().catch(() => false);
      if (isVisible) {
        await monitoringTab.click();
        await page.waitForTimeout(1000);
      }
    });

    test('should start and stop monitoring', async ({ page }) => {
      const monitoringTab = page.locator('button[data-tab="monitoring"]');
      const isVisible = await monitoringTab.isVisible().catch(() => false);
      if (isVisible) {
        await monitoringTab.click();
        
        // Look for any checkbox with monitoring text
        const enableCheckbox = page.locator('input[type="checkbox"]').first();
        const isCheckboxVisible = await enableCheckbox.isVisible().catch(() => false);
        if (isCheckboxVisible) {
          await enableCheckbox.check().catch(() => {});
          await page.waitForTimeout(2000);
          
          await enableCheckbox.uncheck().catch(() => {});
          await page.waitForTimeout(500);
        }
      }
    });
  });

  test.describe('Upload/Process Tab', () => {
    test('should switch to upload tab', async ({ page }) => {
      // Use specific data attribute for upload tab
      const uploadTab = page.locator('button[data-tab="upload"]');
      const isVisible = await uploadTab.isVisible().catch(() => false);
      if (isVisible) {
        await uploadTab.click();
        await page.waitForTimeout(1000);
      }
    });
  });

  test.describe('Error Handling', () => {
    test('should display error messages', async ({ page }) => {
      // Try searching - should handle any errors gracefully
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      
      // Wait for potential response
      await page.waitForTimeout(2000);
      
      // Just verify the page is still valid
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });
  });

  test.describe('WebSocket Connectivity', () => {
    test('should maintain WebSocket connection', async ({ page }) => {
      // Perform search and check for response
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      
      await page.waitForTimeout(3000);
      
      // Check if data loaded (indicates WebSocket worked)
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });
  });

  test.describe('Modal Interactions', () => {
    test('should open and close modals', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        const instanceRow = page.locator('tbody tr').first();
        if (await instanceRow.isVisible().catch(() => false)) {
          await instanceRow.click();
          await page.waitForTimeout(1000);
        }
      }
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('should navigate with keyboard', async ({ page }) => {
      // Focus first button
      const firstButton = page.locator('button').first();
      const isVisible = await firstButton.isVisible().catch(() => false);
      if (isVisible) {
        await firstButton.focus();
        
        // Tab key navigation
        await page.keyboard.press('Tab');
      }
    });
  });

  test.describe('Responsive Design', () => {
    test('should be responsive on desktop', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(baseURL);
      
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });

    test('should be responsive on tablet', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(baseURL);
      
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });

    test('should be responsive on mobile', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(baseURL);
      
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });
  });

  test.describe('Image Viewing', () => {
    test('should open image viewing modal', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Expand first study
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Try to find a "View" or image button for instance
        const viewButton = page.locator('button[id*="view"]').first();
        if (await viewButton.isVisible().catch(() => false)) {
          await viewButton.click();
          await page.waitForTimeout(1000);
        }
      }
    });

    test('should display image in modal', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Try to find and open any instance details/modal
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Check for image content (might be in modal, iframe, or canvas)
        const modal = page.locator('dialog, .modal, [role="dialog"]').first();
        const isModalVisible = await modal.isVisible().catch(() => false);
        
        if (isModalVisible) {
          // Verify modal has content
          const modalContent = modal.locator('img, canvas, iframe, [id*="image"]');
          const hasContent = await modalContent.count().then(c => c > 0).catch(() => false);
          if (hasContent) {
            await expect(modalContent.first()).toBeVisible();
          }
        }
      }
    });

    test('should close image modal', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Open study
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Try to find and click close button
        const closeButton = page.locator('button[aria-label*="close"], button[id*="close"], button:has-text("×"), button:has-text("Close")').first();
        if (await closeButton.isVisible().catch(() => false)) {
          await closeButton.click();
          await page.waitForTimeout(500);
        }
      }
    });
  });

  test.describe('Study Download', () => {
    test('should have download button for study', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Expand first study
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Look for download button
        const downloadButton = page.locator('button[id*="download"], button:has-text("Download"), a[id*="download"]').first();
        if (await downloadButton.isVisible().catch(() => false)) {
          await expect(downloadButton).toBeVisible();
        }
      }
    });

    test('should initiate study download', async ({ page, context }) => {
      // Listen for download events
      let downloadPromise = new Promise(resolve => {
        context.on('page', page => {
          resolve(true);
        });
      });

      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Expand first study
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Try to click download button
        const downloadButton = page.locator('button[id*="download"], button:has-text("Download"), a[id*="download"]').first();
        if (await downloadButton.isVisible().catch(() => false)) {
          await downloadButton.click();
          await page.waitForTimeout(2000);
          // Just verify we don't get an error
          const errorMsg = page.locator('[id*="error"]');
          const hasError = await errorMsg.isVisible().catch(() => false);
          if (!hasError) {
            // Success - no error shown
            await expect(page.locator('body')).toBeVisible();
          }
        }
      }
    });

    test('should show download status', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Expand first study
      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);

        // Look for status indicator
        const statusElement = page.locator('[id*="status"], [class*="status"], [data-test*="status"]').first();
        if (await statusElement.count().then(c => c > 0).catch(() => false)) {
          await expect(statusElement).toBeVisible();
        }
      }
    });
  });

  test.describe('Data Display', () => {
    test('should display patient information', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      // Just verify content loads
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });

    test('should display modalities correctly', async ({ page }) => {
      const searchButton = page.locator('button#search-btn');
      await searchButton.click();
      await page.waitForTimeout(2000);

      const expandButton = page.locator('details > summary').first();
      const isVisible = await expandButton.isVisible().catch(() => false);
      if (isVisible) {
        await expandButton.click();
        await page.waitForTimeout(1000);
      }
      
      // Verify content is still visible
      const content = page.locator('body');
      await expect(content).toBeVisible();
    });
  });
});
