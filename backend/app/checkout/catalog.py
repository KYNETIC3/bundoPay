"""The test store's products. Prices live here, never in the browser, so a buyer can't set their own."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Product:
    id: str
    name: str
    blurb: str
    price: str  # decimal string, as PayPal wants it
    currency: str = "USD"

    def to_json(self) -> dict[str, str]:
        return asdict(self)


CATALOG: dict[str, Product] = {
    p.id: p
    for p in (
        Product("tote", "Canvas tote bag", "A small everyday sale.", "40.00"),
        Product("jacket", "Rain jacket", "A mid-size sale.", "120.00"),
        Product("wholesale", "Wholesale order, 100 jackets", "A big sale, to see a large tax set-aside.", "12400.00"),
    )
}
