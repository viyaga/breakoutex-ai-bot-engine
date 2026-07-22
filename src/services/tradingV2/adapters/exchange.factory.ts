import { TradingConfig } from "../config";
import { BinanceExchangeAdapter } from "./binance.adapter";
import { DeltaExchangeAdapter } from "./delta.adapter";
import { IExchangeAdapter } from "./IExchangeAdapter";

export class ExchangeAdapterFactory {
    private static deltaAdapterInstance = new DeltaExchangeAdapter();
    private static binanceAdapterInstance = new BinanceExchangeAdapter();

    static getAdapter(): IExchangeAdapter {
        let exchange = "delta";
        try {
            const config = TradingConfig.getConfig();
            if (config?.EXCHANGE) {
                exchange = config.EXCHANGE.toLowerCase();
            }
        } catch {
            // Fallback to default exchange if no config context stored
        }

        switch (exchange) {
            case "delta":
                return this.deltaAdapterInstance;
            case "binance":
                return this.binanceAdapterInstance;
            default:
                throw new Error(`Unsupported exchange: ${exchange}`);
        }
    }
}
