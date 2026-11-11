# `localhost:3000`

_Learned from `http://localhost:3000/` by [Context Machines](https://github.com/hughhellings/contextmachines) on 2026-11-11, from the outside: what a visitor can see and do. Correct anything it got wrong: it's yours, and the next run writes beside your edits, never over them._

## Fix first

Proven: the browser saw or measured each of these.

1. **"Import invoices" does nothing when pressed** (`index.html:100`)

Evidence and what to do about it: [FIX.md](FIX.md).

## What it is

Tally is an invoicing product for people who bill clients. It keeps clients and invoices in one place, sends invoices, connects online payments, and exports reports.

## The main thing people come to do

**Save invoice**. The product is for billing clients, and creating an invoice is the core thing a customer comes to record.

## Main journeys

- **Export a report:** Dashboard (`/dashboard`) → Reports (`/reports`)

## Setup steps it depends on

- **Send invoice** needs **Save invoice** first: Sending applies to an invoice, so an invoice must be saved first.

## Parts of the product

| Part | What it's for | How |
| --- | --- | --- |
| Home | Signs a user in to their Tally account. | Enter Email and Password on the Log in page and click Log in. |
| Clients | Adds a client with their name, email, billing address and VAT number so invoices can be made out to them. | Open New client from the menu, fill in Name, Email, Billing address and VAT number, then click Save client. |
| Dashboard | Gives an overview of recent invoices and the starting point for new invoices and imports. | On the Dashboard, review Recent invoices, click New invoice to start an invoice, or click Import invoices to bring invoices in. |
| Invoices | Creates an invoice for a client and then opens it to send it. | On Create invoice, choose a Client, enter Amount and Reg. no., and click Save invoice; on the resulting invoice page, click Send invoice. |
| Reports | Exports report data as a CSV file. | Open Reports from the menu and click Export CSV. |
| Get paid online | Connects a payments account so invoices can be paid online. | Open Get paid online from the menu, enter the Account number, and click Connect payments. |

## Issues found while exploring

Only what the browser saw for itself: a button that did nothing at all, the site's own script failing, a server error or a failed data request, a link it followed that was broken. An image or file that fails may not show up here.

| Issue | Screen | Evidence |
| --- | --- | --- |
| "Import invoices" does nothing when pressed | `/dashboard` | nothing changed on screen, and no request, navigation or dialog followed |

## Screens

| Screen | Address | Photo |
| --- | --- | --- |
| Welcome back | `/` | [photo](screens/home-42099b.jpg) |
| New client | `/clients/new` | [photo](screens/clients_new-2727df.jpg) |
| Dashboard | `/dashboard` | [photo](screens/dashboard.jpg) |
| Invoice | `/invoices/:id` | [photo](screens/invoices_id-bd401b.jpg) |
| Create invoice | `/invoices/new` | [photo](screens/invoices_new-4f8957.jpg) |
| Reports | `/reports` | [photo](screens/reports.jpg) |
| Get paid online | `/settings/payments` | [photo](screens/settings_payments-84d758.jpg) |

## Actions

What people can do that changes something, and the request each one sends (`:id` is any id).

| Action | What it does | Request | Where |
| --- | --- | --- | --- |
| Save client | Stores a new client's name, email, billing address and VAT number so they can be chosen on invoices. | `POST /api/clients` | `/clients/new` |
| Save invoice | Creates a new invoice for a chosen client with an amount and reference number. | `POST /api/invoices` | `/invoices/new` |
| Connect payments | Links a payments account so invoices can be paid online. | `POST /api/payments/connect` | `/settings/payments` |
| Export CSV | Produces a CSV file of report data to download. | `POST /api/reports/export` | `/reports` |
| Send invoice | Sends an existing invoice to its client. | `POST /api/invoices/:id/send` | `/invoices/:id` |

---

Not here: screens behind a sign-in it didn't have (`--login`), and ones that only exist after creating something (`--create`, test accounts only). Learned in 50 seconds. It visited 7 pages, each with a photo. 6 saves were stopped before reaching the site: 1 was a sign-in, sign-up or password form, which isn't listed as an action. The other 5 came from the actions listed.
