import { TradingConfig } from "../config";
import { DeltaExchangeAdapter } from "./delta.adapter";
import { IExchangeAdapter } from "./IExchangeAdapter";

export class ExchangeAdapterFactory {
    private static deltaAdapterInstance = new DeltaExchangeAdapter();

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
            default:
                throw new Error(`Unsupported exchange: ${exchange}`);
        }
    }
}
