/**
 * EXPENSE-VENDOR CLASSIFICATION FIXTURES
 * ────────────────────────────────────────────────────────────────────────────
 * Representative extracted-text samples for the REAL BDK expense vendors, paired
 * with the classification we EXPECT Parsely's Bedrock classifier to produce.
 *
 * Purpose: prove the "does the right doc get through the gate?" boundary. The
 * expense pipeline's EventBridge rule admits ONLY documentType === 'financial'
 * (see bdk-expense-processor entry-gate intent contract). If any of these real
 * vendors' documents classify as anything else, they are silently dropped and
 * never reach the expense processor. These fixtures + the accompanying
 * integration test are the alarm for that failure mode.
 *
 * NOTE ON FIDELITY: these are hand-authored to mirror the structure of real
 * Textract output (vendor letterhead, line items, totals, wording) WITHOUT real
 * account numbers or PII. Real S3 `extracted.txt` samples would be higher
 * fidelity; swap them in here if/when we capture sanitized copies. The signals
 * that drive classification (vendor identity, invoice/receipt wording, amounts,
 * line items) are represented faithfully.
 *
 * Vendor slugs match the RULE#/VENDOR# keys used elsewhere in the system.
 */

export interface ExpenseVendorFixture {
  /** Vendor slug (matches Parsely VENDOR# config + expense RULE# keys). */
  vendorSlug: string
  /** Human label for test output. */
  label: string
  /** Representative extracted document text (as Textract would produce). */
  text: string
  /** MUST classify as 'financial' to pass the expense-pipeline entry gate. */
  expectedDocumentType: 'financial'
  /** Expected financial subType (invoice | receipt | notification). */
  expectedSubType: string
  /** Regex the returned vendorName must match (ID slug OR display name). */
  vendorNameMatch: RegExp
  /** True for vendors whose docs require multi-line catalog reconciliation. */
  isMultiLine: boolean
}

const RESTAURANT_DEPOT: ExpenseVendorFixture = {
  vendorSlug: 'restaurant-depot',
  label: 'Restaurant Depot (multi-line wholesale receipt)',
  isMultiLine: true,
  expectedDocumentType: 'financial',
  expectedSubType: 'receipt',
  vendorNameMatch: /restaurant.?depot/i,
  text: `RESTAURANT DEPOT
JETRO CASH & CARRY ENTERPRISES LLC
1755 4TH AVE S, SEATTLE, WA 98134
MEMBER: BERLINER DONER KEBAB

Cashier: 04    Reg: 07    Trans: 118293
07/22/2026  14:32

QTY  DESCRIPTION                    AMOUNT
2    CLAMSHELL 8X8 3-COMP 200CT      59.98
1    FOIL ROLL 18IN HEAVY DUTY       42.50
3    NITRILE GLOVES LG 100CT         74.97
4    CHICKEN THIGH BNLS SKNLS CS    189.60
2    BEEF GYRO CONE 40LB            220.00
1    TO-GO BAGS PAPER 500CT          38.99
1    DEGREASER CONCENTRATE GAL       21.49

SUBTOTAL                            647.53
TAX                                  19.20
TOTAL                               666.73

PAYMENT: VISA ****4821
THANK YOU FOR SHOPPING RESTAURANT DEPOT`,
}

const FRANZ_BAKERY: ExpenseVendorFixture = {
  vendorSlug: 'franz-bakery',
  label: 'Franz Bakery (single-vendor delivery invoice)',
  isMultiLine: false,
  expectedDocumentType: 'financial',
  expectedSubType: 'invoice',
  vendorNameMatch: /franz/i,
  text: `FRANZ BAKERY
UNITED STATES BAKERY, INC.
340 NW 11TH AVE, PORTLAND, OR 97209

INVOICE

Bill To: Berliner Doner Kebab
Invoice #: FZ-2026-558201
Invoice Date: 07/25/2026
Terms: Net 15

Route Delivery - Bread Products
  Sandwich Rolls 6in (12 cases)        228.00
  Pita Flatbread (8 cases)             147.65
  Burger Buns (5 cases)                100.00

Subtotal                               475.65
Amount Due                             475.65

Please remit payment within 15 days.
Thank you for your business.`,
}

const CENTURYLINK: ExpenseVendorFixture = {
  vendorSlug: 'centurylink',
  label: 'CenturyLink (utility/telecom bill notification)',
  isMultiLine: false,
  expectedDocumentType: 'financial',
  expectedSubType: 'notification',
  vendorNameMatch: /centurylink|lumen/i,
  text: `CenturyLink
Lumen Technologies

Your monthly statement is ready

Account: 206-555-0148 227B
Billing Date: July 20, 2026
Service Address: 4525 University Way NE, Seattle, WA 98105

Current Charges
  Business Fiber Internet 200M          89.00
  Static IP Address                     15.00
  Taxes, Fees & Surcharges              12.47

Total Amount Due                       116.47
Autopay Date: August 5, 2026

Your payment will be automatically withdrawn.
Thank you for choosing CenturyLink.`,
}

const ARE_SEATTLE: ExpenseVendorFixture = {
  vendorSlug: 'are-seattle',
  label: 'ARE (Alsco / restaurant equipment & linen service invoice)',
  isMultiLine: false,
  expectedDocumentType: 'financial',
  expectedSubType: 'invoice',
  vendorNameMatch: /\bare\b|american restaurant|alsco/i,
  text: `ARE - AMERICAN RESTAURANT EQUIPMENT
SEATTLE, WA

INVOICE

Customer: Berliner Doner Kebab
Invoice Number: ARE-778102
Date: 07/23/2026
Terms: Due on Receipt

Weekly Linen & Mat Service
  Kitchen Towel Rental (50)             45.00
  Floor Mat Service (4)                 32.00
  Apron Rental (12)                     28.50

Subtotal                               105.50
Tax                                      10.24
Total Due                              115.74

Remit to: ARE Seattle Accounts Receivable`,
}

export const EXPENSE_VENDOR_FIXTURES: ExpenseVendorFixture[] = [
  RESTAURANT_DEPOT,
  FRANZ_BAKERY,
  CENTURYLINK,
  ARE_SEATTLE,
]

/**
 * The full TYPE# config surfaced to the classifier prompt, mirroring the
 * seeded BDK config (financial/tax/correspondence with subType hints). Kept in
 * sync with data/seed-classifications.ts intent.
 */
export const BDK_FULL_TYPES = `- tax (subTypes: notice [hints: cp2000, balance due, tax due, penalty, assessment]; return [hints: 1040, w2, tax return])
- financial (subTypes: invoice [hints: invoice, amount due, net 15, net 30, terms, remit]; receipt [hints: receipt, payment received, cashier, subtotal, thank you for shopping]; notification [hints: auto pay, autopay, payment scheduled, monthly statement, billing, utility bill, monthly charge, subscription, your payment])
- correspondence (subTypes: letter [hints: dear, sincerely, regards]; notification [hints: notification, notice, alert, important update]; memo [hints: memo, memorandum])`

/** The known-vendors block for the classifier prompt (BDK expense vendors). */
export const BDK_EXPENSE_VENDORS = `- restaurant-depot: "Restaurant Depot" (aliases: restaurant depot, jetro, cash & carry)
- franz-bakery: "Franz Bakery" (aliases: franz, united states bakery)
- centurylink: "CenturyLink" (aliases: centurylink, lumen)
- are-seattle: "ARE Seattle" (aliases: are, american restaurant equipment, alsco)`
