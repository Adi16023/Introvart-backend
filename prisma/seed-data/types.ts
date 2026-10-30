export type FulfilmentType =
  | "platform_pod"
  | "seller_fulfilled"
  | "custom_print"
  | "personalized"
  | "original"
  | "commission";

export type ProductStatus =
  | "draft"
  | "submitted"
  | "changes_required"
  | "approved"
  | "rejected"
  | "suspended";

export type AdminRole =
  | "moderator"
  | "support"
  | "operations"
  | "finance"
  | "marketing"
  | "super";

export type SizeOption = { id: string; label: string; cm: string; price: number };
export type MaterialOption = { id: string; label: string; multiplier: number };
export type FrameOption = { id: string; label: string; price: number; swatch: string };

export type Artist = {
  id: string;
  slug: string;
  name: string;
  city: string;
  bio: string;
  cover: string;
  portrait: string;
  verified: boolean;
  styles: string[];
  social: string;
  kyc: "pending" | "verified" | "expired";
  gst?: string;
  pan: string;
  bank: string;
  ifsc: string;
  commissionEnabled: boolean;
  mediums: string[];
  priceFrom: number;
  turnaround: string;
  slots: number;
  royaltyRate: number;
  commissionRate: number;
};

export type Product = {
  id: string;
  slug: string;
  title: string;
  artistId: string;
  story: string;
  image: string;
  roomImage: string;
  category: string;
  colours: string[];
  rooms: string[];
  occasions: string[];
  orientation: "portrait" | "landscape" | "square";
  style: string;
  fulfilment: FulfilmentType;
  priceFactor: number;
  basePrice: number;
  royaltyRate: number;
  rating: number;
  reviewCount: number;
  stock: number | null;
  status: ProductStatus;
  moderatorNote?: string;
  personalization?: { key: string; label: string; placeholder: string }[];
  tags: string[];
};

export type Review = {
  id: string;
  productId: string;
  author: string;
  rating: number;
  text: string;
  photo?: string;
  status: "pending" | "approved" | "rejected";
  helpful: number;
  verified: boolean;
};

export type CartItem = {
  id: string;
  productId?: string;
  title: string;
  artistName: string;
  image: string;
  fulfilment: FulfilmentType;
  sizeId: string;
  materialId: string;
  frameId: string;
  quantity: number;
  personalization?: Record<string, string>;
  note?: string;
  gift: boolean;
  giftMessage: string;
};

export type Address = {
  id: string;
  name: string;
  phone: string;
  line: string;
  city: string;
  state: string;
  pincode: string;
  label: string;
};

export type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  risk: string | null;
  credit: number;
  referral: string;
};

export type OrderItem = {
  id: string;
  title: string;
  artistName: string;
  image: string;
  fulfilment: FulfilmentType;
  sizeLabel: string;
  materialLabel: string;
  frameLabel: string;
  quantity: number;
  unitPrice: number;
  status: string;
  gift: boolean;
  giftMessage: string;
  creatorId?: string;
};

export type Order = {
  id: string;
  customerId: string;
  customerName: string;
  email: string;
  placedAt: string;
  address: Address;
  delivery: "standard" | "express";
  paymentMethod: string;
  paymentStatus: "pending" | "paid" | "failed" | "cod";
  coupon?: string;
  discount: number;
  shipping: number;
  giftCardCode?: string;
  giftCardAmount: number;
  creditUsed: number;
  items: OrderItem[];
  gstInvoice: boolean;
};

export type PrintJob = {
  id: string;
  orderId: string;
  itemId: string;
  title: string;
  image: string;
  spec: string;
  quantity: number;
  status: string;
  priority: "normal" | "rush";
  due: string;
  defect?: string;
  giftSlip: boolean;
  awb?: string;
};

export type CommissionRequest = {
  id: string;
  customerName: string;
  artistId: string;
  medium: string;
  size: string;
  style: string;
  notes: string;
  budget: number;
  deadline: string;
  status: string;
  quote?: { price: number; timeline: string; revisions: number };
  progress: { at: string; text: string }[];
  paid: number;
};

export type GiftCard = {
  id: string;
  code: string;
  amount: number;
  balance: number;
  from: string;
  to: string;
  email: string;
  message: string;
  theme: string;
  sendOn: string;
  status: "active" | "void" | "scheduled";
};

export type Ticket = {
  id: string;
  from: string;
  subject: string;
  orderId?: string;
  status: "open" | "pending" | "resolved";
  channel: string;
  body: string;
};

export type ReturnCase = {
  id: string;
  orderId: string;
  itemTitle: string;
  reason: string;
  type: "refund" | "replacement" | "reprint";
  status: string;
  evidence: string;
};

export type BulkOrder = {
  id: string;
  company: string;
  contact: string;
  city: string;
  brief: string;
  quantity: number;
  budget: number;
  status: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
};

export type Saved = {
  id: string;
  title: string;
  image: string;
  kind: string;
  detail: string;
};

export type Banner = {
  id: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  href: string;
  image: string;
};

export type Coupon = {
  code: string;
  label: string;
  kind: "percent" | "flat" | "shipping";
  value: number;
  min: number;
};

export type PricingConfig = {
  taxRate: number;
  freeShippingOver: number;
  standardShipping: number;
  expressShipping: number;
  codLimit: number;
  personalizationFee: number;
  sizes: SizeOption[];
  materials: MaterialOption[];
  frames: FrameOption[];
  coupons: Coupon[];
};

export type AppState = {
  artists: Artist[];
  products: Product[];
  reviews: Review[];
  customers: Customer[];
  cart: CartItem[];
  wishlist: string[];
  follows: string[];
  recent: string[];
  recentSearches: string[];
  orders: Order[];
  jobs: PrintJob[];
  commissions: CommissionRequest[];
  giftCards: GiftCard[];
  tickets: Ticket[];
  returns: ReturnCase[];
  b2b: BulkOrder[];
  audit: AuditEntry[];
  designs: Saved[];
  banners: Banner[];
  addresses: Address[];
  config: PricingConfig;
  sessionCustomerId: string | null;
  creatorId: string;
  adminRole: AdminRole;
  partnerName: string;
  capacity: number;
  holidays: string;
};
