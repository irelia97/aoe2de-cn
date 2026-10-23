#!/usr/bin/env python3
"""Log in to Douyu or Bilibili and send a danmaku with Playwright.

The first login is completed interactively in a visible browser.  Playwright's
storage state is then saved locally and reused by headless ``send`` calls.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import json
import re
import sys
from pathlib import Path
from typing import Iterable

from playwright.async_api import (
    Browser,
    BrowserContext,
    Error as PlaywrightError,
    Locator,
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeoutError,
    async_playwright,
)

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


PROJECT_ROOT = Path(__file__).resolve().parents[1]
STATE_ROOT = PROJECT_ROOT / ".cache" / "danmaku"

PLATFORMS = {
    "douyu": {
        "name": "斗鱼",
        "max_length": 50,
        "home": "https://www.douyu.com/",
        "login": "https://passport.douyu.com/member/login",
        "qr_selector": ".scan-qrcode",
        "auth_cookies": ("acf_auth", "acf_uid"),
        "room_pattern": re.compile(r"(?:https?://)?(?:www\.)?douyu\.com/(\d+)", re.I),
        "room_url": "https://www.douyu.com/{room_id}",
    },
    "bilibili": {
        "name": "哔哩哔哩直播",
        "max_length": 80,
        "home": "https://live.bilibili.com/",
        "login": "https://passport.bilibili.com/login",
        "qr_selector": ".login-scan__qrcode",
        "auth_cookies": ("SESSDATA", "DedeUserID"),
        "room_pattern": re.compile(
            r"(?:https?://)?live\.bilibili\.com/(?:blanc/)?(\d+)", re.I
        ),
        "room_url": "https://live.bilibili.com/{room_id}",
    },
}

# Douyu has renamed these classes several times.  Prefer semantic selectors,
# then fall back to known class names used by the current and older pages.
CHAT_INPUT_SELECTORS = (
    'textarea[placeholder*="弹幕"]',
    'textarea[placeholder*="发言"]',
    'textarea[placeholder*="聊天"]',
    '.ChatSend textarea',
    '.ChatSend-txt textarea',
    '.ChatSend-txt',
    '[class*="ChatSend"] [contenteditable="true"]',
    '[contenteditable="true"][data-placeholder*="弹幕"]',
    '[contenteditable="true"][aria-label*="弹幕"]',
    'textarea.chat-input',
    '.chat-input textarea',
    '.chat-input[contenteditable="true"]',
    '[class*="chat-input"] [contenteditable="true"]',
    'textarea[placeholder*="说点什么"]',
)

SEND_BUTTON_SELECTORS = (
    'button:has-text("发送")',
    '[role="button"]:has-text("发送")',
    '.ChatSend-button',
    '.ChatSend-send',
    '[class*="ChatSend"] [class*="send"]',
    '.send-btn',
    '.chat-send-btn',
    '[class*="send-btn"]',
)


class LiveDanmakuError(RuntimeError):
    """A user-facing live-platform automation error."""


def normalize_room_url(platform: str, value: str) -> str:
    value = value.strip()
    settings = PLATFORMS[platform]
    if value.isdigit():
        return settings["room_url"].format(room_id=value)
    match = settings["room_pattern"].search(value)
    if not match:
        raise LiveDanmakuError(
            f"直播间必须是纯数字房间号或{settings['name']}直播间网址"
        )
    return settings["room_url"].format(room_id=match.group(1))


def state_path_for(args: argparse.Namespace) -> Path:
    return args.state or STATE_ROOT / f"{args.platform}_storage_state.json"


def screenshot_path_for(platform: str) -> Path:
    return STATE_ROOT / f"{platform}_last_error.png"


def ensure_private_file(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o600)


async def launch_browser(playwright: Playwright, *, headless: bool) -> Browser:
    return await playwright.chromium.launch(
        headless=headless,
        args=("--disable-blink-features=AutomationControlled",),
    )


async def new_context(
    browser: Browser,
    *,
    state_path: Path | None = None,
) -> BrowserContext:
    kwargs: dict[str, object] = {
        "locale": "zh-CN",
        "timezone_id": "Asia/Shanghai",
        "viewport": {"width": 1440, "height": 900},
    }
    if state_path is not None:
        if not state_path.is_file():
            raise LiveDanmakuError(
                f"尚未找到登录会话：{state_path}\n"
                "请先运行 login 命令完成登录。"
            )
        kwargs["storage_state"] = str(state_path)
    return await browser.new_context(**kwargs)


async def first_visible(page: Page, selectors: Iterable[str]) -> Locator | None:
    for selector in selectors:
        locator = page.locator(selector)
        for index in range(await locator.count()):
            item = locator.nth(index)
            try:
                if await item.is_visible():
                    return item
            except Exception:
                continue
    return None


async def wait_for_chat_input(page: Page, timeout_ms: int) -> Locator:
    deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
    while asyncio.get_running_loop().time() < deadline:
        item = await first_visible(page, CHAT_INPUT_SELECTORS)
        if item is not None:
            return item
        await asyncio.sleep(0.5)
    raise LiveDanmakuError(
        "没有找到可用的弹幕输入框。登录可能已失效，直播间也可能关闭了发言。"
    )


async def fill_chat_input(locator: Locator, message: str) -> None:
    # Playwright supports input, textarea and contenteditable elements.  Its
    # fill implementation emits the framework-visible input events that the
    # Douyu chat component requires.
    await locator.fill(message)


async def chat_input_text(locator: Locator) -> str:
    tag_name = await locator.evaluate("element => element.tagName.toLowerCase()")
    if tag_name in {"textarea", "input"}:
        return await locator.input_value()
    return (await locator.inner_text()).strip()


async def save_failure_screenshot(page: Page, screenshot_path: Path) -> None:
    screenshot_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        await page.screenshot(path=str(screenshot_path), full_page=False)
    except Exception:
        pass


async def command_login(args: argparse.Namespace) -> None:
    state_path = state_path_for(args)
    settings = PLATFORMS[args.platform]
    state_path.parent.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await launch_browser(playwright, headless=args.headless_qr)
        context = await new_context(browser)
        page = await context.new_page()
        await page.goto(settings["login"], wait_until="domcontentloaded")
        if args.headless_qr:
            qr_path = STATE_ROOT / f"{args.platform}_login_qr.png"
            qr_path.parent.mkdir(parents=True, exist_ok=True)
            qr = page.locator(settings["qr_selector"]).first
            try:
                await qr.wait_for(state="visible", timeout=30_000)
                if args.platform == "douyu":
                    canvas = page.locator(".js-qrcode-con canvas, .scan-qrcode canvas").first
                    await canvas.wait_for(state="visible", timeout=30_000)
                    await page.wait_for_timeout(1_500)
                    # Douyu paints the QR code into a canvas. Element screenshots
                    # of .scan-qrcode are blank in headless Chromium, while the
                    # composited page screenshot contains the rendered canvas.
                    await page.screenshot(path=str(qr_path), full_page=False)
                else:
                    await qr.screenshot(path=str(qr_path))
            except Exception:
                await page.screenshot(path=str(qr_path), full_page=False)
            print(f"登录二维码已保存：{qr_path}", flush=True)
            deadline = asyncio.get_running_loop().time() + args.timeout
            while asyncio.get_running_loop().time() < deadline:
                cookies = await context.cookies()
                cookie_names = {cookie["name"] for cookie in cookies}
                if all(name in cookie_names for name in settings["auth_cookies"]):
                    await context.storage_state(path=str(state_path))
                    ensure_private_file(state_path)
                    await browser.close()
                    print(f"登录成功，会话已保存：{state_path}", flush=True)
                    return
                await asyncio.sleep(2)
            await browser.close()
            raise LiveDanmakuError(f"等待扫码登录超过 {args.timeout} 秒")
        print(
            f"浏览器已打开。请在{settings['name']}页面中完成扫码、短信或其他验证登录。"
        )
        await asyncio.to_thread(input, "确认页面已经登录后，回到这里按 Enter 保存会话：")
        await context.storage_state(path=str(state_path))
        ensure_private_file(state_path)
        await browser.close()
    print(f"登录会话已保存：{state_path}")


async def open_room_with_state(
    playwright: Playwright,
    *,
    state_path: Path,
    url: str,
    headless: bool,
    timeout_ms: int,
    screenshot_path: Path,
    websocket_observer=None,
) -> tuple[Browser, BrowserContext, Page, Locator]:
    if not state_path.is_file():
        raise LiveDanmakuError(
            f"尚未找到登录会话：{state_path}\n请先运行 login 命令完成登录。"
        )
    browser = await launch_browser(playwright, headless=headless)
    context = await new_context(browser, state_path=state_path)
    page = await context.new_page()
    if websocket_observer is not None:
        page.on("websocket", websocket_observer)
    page.set_default_timeout(timeout_ms)
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        chat_input = await wait_for_chat_input(page, timeout_ms)
        return browser, context, page, chat_input
    except Exception:
        await save_failure_screenshot(page, screenshot_path)
        await browser.close()
        raise


async def command_check(args: argparse.Namespace) -> None:
    state_path = state_path_for(args)
    screenshot_path = screenshot_path_for(args.platform)
    target_url = normalize_room_url(args.platform, args.room)
    async with async_playwright() as playwright:
        browser, _, page, _ = await open_room_with_state(
            playwright,
            state_path=state_path,
            url=target_url,
            headless=args.headless,
            timeout_ms=args.timeout * 1000,
            screenshot_path=screenshot_path,
        )
        print(f"登录会话有效，直播间弹幕输入框可用：{page.url}")
        await browser.close()


async def command_send(args: argparse.Namespace) -> None:
    messages = [] if args.message_stdin else [args.message.strip()] + [text.strip() for text in (args.next_message or [])]
    max_length = args.max_length or PLATFORMS[args.platform]["max_length"]
    for message in messages:
        if not message:
            raise LiveDanmakuError("弹幕内容不能为空")
        if len(message) > max_length:
            raise LiveDanmakuError(f"弹幕长度为 {len(message)}，超过限制 {max_length}。")

    state_path = state_path_for(args)
    screenshot_path = screenshot_path_for(args.platform)
    target_url = normalize_room_url(args.platform, args.room)
    douyu_ws_event: asyncio.Event | None = None
    douyu_ack_event: asyncio.Event | None = None
    douyu_ack_result: dict[str, int | None] = {"res": None}
    websocket_observer = None
    if args.platform == "douyu":
        douyu_ws_event = asyncio.Event()
        douyu_ack_event = asyncio.Event()

        def websocket_observer(websocket) -> None:
            if "wsproxy.douyu.com" not in websocket.url:
                return
            douyu_ws_event.set()

            def on_frame(payload) -> None:
                raw = payload if isinstance(payload, bytes) else str(payload).encode()
                if b"type@=chatres/" not in raw:
                    return
                match = re.search(rb"(?:^|/)res@=(-?\d+)(?:/|$)", raw)
                if match:
                    douyu_ack_result["res"] = int(match.group(1))
                    douyu_ack_event.set()

            websocket.on("framereceived", on_frame)

    async with async_playwright() as playwright:
        browser, context, page, chat_input = await open_room_with_state(
            playwright,
            state_path=state_path,
            url=target_url,
            headless=args.headless,
            timeout_ms=args.timeout * 1000,
            screenshot_path=screenshot_path,
            websocket_observer=websocket_observer,
        )
        try:
            # Douyu creates the chat WebSocket shortly after the input becomes
            # usable.  Give it a moment so the send acknowledgement can be
            # observed reliably instead of racing the socket connection.
            if args.platform == "douyu":
                try:
                    await asyncio.wait_for(douyu_ws_event.wait(), timeout=15)
                except TimeoutError as error:
                    raise LiveDanmakuError("斗鱼聊天连接未能及时建立") from error
                await page.wait_for_timeout(1500)
            if args.message_stdin:
                payload = await asyncio.wait_for(asyncio.to_thread(sys.stdin.readline), timeout=args.message_wait)
                messages = json.loads(payload)
                if not isinstance(messages, list) or not messages or any(not isinstance(text, str) or not text.strip() or len(text) > max_length for text in messages):
                    raise LiveDanmakuError("Invalid pending messages")
            for message_index, message in enumerate(messages):
                await fill_chat_input(chat_input, message)
                if args.dry_run:
                    print("试运行成功：已找到输入框并填入文字，没有发送。")
                    return

                if douyu_ack_event is not None:
                    douyu_ack_event.clear()
                    douyu_ack_result["res"] = None
                send_button = await first_visible(page, SEND_BUTTON_SELECTORS)
                if send_button is not None and await send_button.is_enabled():
                    # The editor is already focused by fill(). Avoid waiting for
                    # animated overlays to stop intercepting a pointer click.
                    await send_button.evaluate("element => element.click()")
                else:
                    await chat_input.press("Enter")

                await page.wait_for_timeout(600)
                remaining = await chat_input_text(chat_input)
                if remaining == message:
                    await chat_input.press("Enter")
                    await page.wait_for_timeout(1000)
                    remaining = await chat_input_text(chat_input)
                if remaining == message:
                    raise LiveDanmakuError("发送后输入框没有清空，页面未接受本次弹幕")
                if douyu_ack_event is not None:
                    try:
                        await asyncio.wait_for(douyu_ack_event.wait(), timeout=5)
                    except TimeoutError as error:
                        raise LiveDanmakuError("未收到斗鱼弹幕服务器的发送确认") from error
                    if douyu_ack_result["res"] != 0:
                        raise LiveDanmakuError(
                            f"斗鱼弹幕服务器拒绝发送，返回码 {douyu_ack_result['res']}"
                        )
                print("DANMAKU_SENT " + json.dumps({"index":message_index}, ensure_ascii=True), flush=True)
                if message_index + 1 < len(messages):
                    await page.wait_for_timeout(10000)
            await context.storage_state(path=str(state_path))
            ensure_private_file(state_path)
            print(f"弹幕发送操作已完成：{page.url}")
        except Exception:
            await save_failure_screenshot(page, screenshot_path)
            raise
        finally:
            await browser.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="使用浏览器登录斗鱼或哔哩哔哩并向指定直播间发送弹幕"
    )
    parser.add_argument(
        "--state",
        type=Path,
        default=None,
        help="自定义登录会话文件；默认按平台保存到 .cache/danmaku/",
    )
    parser.add_argument(
        "--platform",
        choices=tuple(PLATFORMS),
        default="douyu",
        help="直播平台（默认：douyu）",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    login = subparsers.add_parser("login", help="打开浏览器并保存登录会话")
    login.add_argument(
        "--headless-qr",
        action="store_true",
        help="生成二维码图片并等待扫码，适用于无桌面环境",
    )
    login.add_argument("--timeout", type=int, default=300, help="等待扫码的秒数")

    check = subparsers.add_parser("check", help="检查登录会话和直播间输入框")
    check.add_argument("--room", required=True, help="房间号或直播间网址")
    check.add_argument("--timeout", type=int, default=30, help="等待页面的秒数")
    check.add_argument("--headed", dest="headless", action="store_false", help="显示浏览器窗口")
    check.set_defaults(headless=True)

    send = subparsers.add_parser("send", help="向直播间发送一条弹幕")
    send.add_argument("--room", required=True, help="房间号或直播间网址")
    message_source = send.add_mutually_exclusive_group(required=True)
    message_source.add_argument("--message", help="弹幕正文")
    message_source.add_argument("--message-stdin", action="store_true", help="打开直播间后等待标准输入提供弹幕")
    send.add_argument("--message-wait", type=int, default=60, help="等待弹幕信息的秒数")
    send.add_argument("--next-message", action="append", help="在同一页面继续发送的弹幕")
    send.add_argument("--timeout", type=int, default=30, help="等待页面的秒数")
    send.add_argument(
        "--max-length",
        type=int,
        default=None,
        help="覆盖平台默认限制（斗鱼 50，B站 80）",
    )
    send.add_argument("--dry-run", action="store_true", help="只填入内容，不执行发送")
    send.add_argument("--headed", dest="headless", action="store_false", help="显示浏览器窗口")
    send.set_defaults(headless=True)

    return parser


async def async_main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "login":
            await command_login(args)
        elif args.command == "check":
            await command_check(args)
        else:
            await command_send(args)
        return 0
    except (LiveDanmakuError, PlaywrightTimeoutError, PlaywrightError) as error:
        print(f"错误：{error}", file=sys.stderr)
        screenshot_path = screenshot_path_for(args.platform)
        if screenshot_path.exists():
            print(f"诊断截图：{screenshot_path}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(async_main()))
