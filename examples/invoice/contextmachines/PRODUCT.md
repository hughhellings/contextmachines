# `localhost:3000`

_Learned from `http://localhost:3000/` by [Context Machines](https://github.com/hughhellings/contextmachines) on 2026-11-11, from the outside: what a visitor can see and do. Correct anything it got wrong: it's yours, and the next run writes beside your edits, never over them._

## Fix first

Proven: the browser saw or measured each of these.

1. **"Import invoices" does nothing when pressed** (`index.html:73`)

Evidence and what to do about it: [FIX.md](FIX.md).

## What it is

Invoice Demo is an invoicing tool for small businesses to bill their clients, send invoices, and get paid online. It serves the business owner or staff member who issues invoices.

## The main thing people come to do

**Save invoice**. The product is for issuing invoices, and creating an invoice is the action that produces the thing it exists for.

## Main journeys

- **Add a client and issue an invoice:** Welcome back (`/`) → Dashboard (`/dashboard`) → New client (`/clients/new`) → Create invoice (`/invoices/new`)
- **Connect payments to get paid online:** Welcome back (`/`) → Dashboard (`/dashboard`) → Get paid online (`/settings/payments`)

## Setup steps it depends on

- **Send invoice** needs **Save invoice** first: The Send invoice button is on an invoice page, so the invoice must be saved before it can be sent.

## Parts of the product

| Part | What it's for | How |
| --- | --- | --- |
| Home | Signs the user into their Invoice Demo account. | On the Welcome back screen, enter Email and Password and click Log in. |
| Clients | Records the clients that invoices are issued to. | On the New client screen, enter Name, Email, Billing address and VAT number, then click Save client. |
| Dashboard | Is the starting point for the main areas of the product. | On the Dashboard, click New invoice to start an invoice, or use the links to clients, reports and payments; Import invoices is also offered here. |
| Invoices | Creates invoices for clients and sends them. | On the Create invoice screen, choose a Client, enter Amount and Reg. no., and click Save invoice; on the invoice page, click Send invoice to send it. |
| Reports | Exports reporting data out of the product. | On the Reports screen, click Export CSV. |
| Get paid online | Connects a payment account so invoices can be paid online. | On the Get paid online screen, enter Account number and click Connect payments. |

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
| Save client | Saves a new client's name, email, billing address and VAT number so they can be chosen on invoices. | `POST /api/clients` | `/clients/new` |
| Save invoice | Creates a new invoice for a chosen client with an amount and reg. no. | `POST /api/invoices` | `/invoices/new` |
| Connect payments | Connects a payment account by its account number so the business can get paid online. | `POST /api/payments/connect` | `/settings/payments` |
| Export CSV | Exports the report as a CSV file. | `POST /api/reports/export` | `/reports` |
| Send invoice | Sends an existing invoice to its client. | `POST /api/invoices/:id/send` | `/invoices/:id` |

---

Not here: screens behind a sign-in it didn't have (`--login`), and ones that only exist after creating something (`--create`, test accounts only). Learned in 56 seconds. It visited 7 pages, each with a photo. 6 saves were stopped before reaching the site: 1 was a sign-in, sign-up or password form, which isn't listed as an action. The other 5 came from the actions listed.
