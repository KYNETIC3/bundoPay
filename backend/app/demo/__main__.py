"""Create or refresh the hosted demo login. Run with: uv run python -m app.demo"""

import asyncio

from app.db import close_pool, open_pool
from app.deps import close_gateway

from .service import setup


async def main() -> None:
    await open_pool()
    try:
        merchant_id = await setup()
        print(f"Demo account ready ({merchant_id}). The worker will sync its disputes shortly.")
    finally:
        await close_gateway()
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
