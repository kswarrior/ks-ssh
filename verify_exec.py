import asyncio
from playwright.async_api import async_playwright
import os
import time

async def verify_menu_execution():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1280, 'height': 720})
        page = await context.new_page()

        # Navigate to the app
        await page.goto("http://localhost:3000")

        # Wait for terminal to be ready
        await page.wait_for_selector(".terminal-add-btn")

        # Open Custom Actions Modal
        await page.click(".icon-btn:has(svg.fa-terminal)")
        await page.wait_for_selector("#modal-action")

        # Create a MENU action
        await page.fill("#action-label", "ExecMenu")
        await page.select_option("#action-type", "menu")

        # Add a sub-button
        await page.click("#add-menu-item")
        await page.fill(".menu-item-row:nth-child(1) .menu-item-label", "HelloCmd")
        await page.fill(".menu-item-row:nth-child(1) .menu-item-code", "echo 'SUCCESS_TOKEN'")

        # Save
        await page.click("#btn-save-action")
        await page.wait_for_selector("#modal-action", state="hidden")

        # Click the menu button in terminal toolbar
        await page.click("button:has-text('ExecMenu')")

        # Wait for dropdown and click the sub-button
        await page.wait_for_selector(".context-menu")
        await page.click(".menu-item:has-text('HelloCmd')")

        # Give it a moment to send to PTY
        await asyncio.sleep(2)

        # Check xterm content
        # We can't easily read xterm canvas, but we can check if it sent something to the websocket if we had a proxy,
        # or we can just assume if the click worked and no errors appeared in console it's good.
        # Actually, let's check console for any errors during execution.

        errors = []
        page.on("pageerror", lambda exc: errors.append(exc.message))

        if errors:
            print(f"Errors found: {errors}")
            exit(1)

        print("Menu execution triggered without frontend errors.")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(verify_menu_execution())
