// The parts of PayPal's JavaScript SDK v6 the test store uses (https://developer.paypal.com/sdk/js/).

type PayPalOrderResult = { orderId: string };

interface PayPalOneTimePaymentSession {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<PayPalOrderResult>): Promise<void>;
}

interface PayPalSdkInstance {
  findEligibleMethods(options: { currencyCode: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: {
    onApprove: (data: { orderId: string }) => Promise<void> | void;
    onCancel?: () => void;
    onError?: (error: unknown) => void;
  }): PayPalOneTimePaymentSession;
}

interface Window {
  paypal?: {
    createInstance(options: { clientId: string; components: string[]; pageType?: string }): Promise<PayPalSdkInstance>;
  };
}

declare namespace React.JSX {
  interface IntrinsicElements {
    "paypal-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { type?: string };
  }
}
