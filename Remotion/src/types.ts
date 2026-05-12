export type QuoteVariant = 'editorial' | 'source-led' | 'minimal';

export type QuoteVideoProps = {
  transparent?: boolean;
  variant?: QuoteVariant;
  source?: string;
  quote: string;
  author?: string;
  role?: string;
  date?: string;
  label?: string;
  accent?: string;
  background?: {
    image?: string;
    blur?: number;
    dim?: number;
  };
};
