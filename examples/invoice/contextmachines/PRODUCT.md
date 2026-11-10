# `localhost:3000`

_Learned from `http://localhost:3000/` by [Context Machines](https://github.com/hughhellings/contextmachines) on 2026-11-10, from the outside: what a visitor can see and do. Correct anything it got wrong: it's yours, and the next run writes beside your edits, never over them._

## Fix first

Proven: the browser saw or measured each of these.

1. **"Import invoices" does nothing when pressed** (`index.html:73`)

Evidence and what to do about it: [FIX.md](FIX.md).

## What it is

An invoicing app for small businesses to manage clients, create and send invoices, export reports, and connect online payments. It is used by freelancers and small business owners who bill their clients.

## The main thing people come to do

**Save invoice**. The product promises invoicing, and creating an invoice is the thing customers come to make, which sending then follows.

## Setup steps it depends on

- **Save invoice** needs **Save client** first: An invoice is made out to a client, and the Client field draws on saved clients.
- **Send invoice** needs **Save invoice** first: An invoice must be saved before it can be opened and sent.

## Parts of the product

| Part | What it's for | How |
| --- | --- | --- |
| Home | Signs a user into the app with email and password. | On the Log in page, enter Email and Password in the form and click Log in. |
| Clients | Adds a client that invoices can be billed to. | Open New client, fill in Name, Email, Billing address and VAT number, then click Save client. |
| Dashboard | Gives a starting point to create invoices and import existing ones. | On the Dashboard, click New invoice to start an invoice or Import invoices to bring them in. |
| Invoices | Creates invoices for clients and sends them out. | Click New invoice, pick a Client, enter Amount and Reg. no., then click Save invoice; open the invoice and click Send invoice to send it. |
| Reports | Exports financial data for use outside the app. | On the Reports page, click Export CSV. |
| Get paid online | Connects an account so clients can pay invoices online. | On Get paid online, enter Account number and click Connect payments. |

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
| Save client | Stores a new client with its name, email, billing address and VAT number so invoices can be made out to them. | `POST /api/clients` | `/clients/new` |
| Save invoice | Creates a new invoice for a chosen client with an amount and reference number. | `POST /api/invoices` | `/invoices/new` |
| Connect payments | Connects a payment account so clients can pay invoices online. | `POST /api/payments/connect` | `/settings/payments` |
| Export CSV | Exports report data as a CSV file. | `POST /api/reports/export` | `/reports` |
| Send invoice | Sends an existing invoice out to the client. | `POST /api/invoices/:id/send` | `/invoices/:id` |

---

Not here: screens behind a sign-in it didn't have (`--login`), and ones that only exist after creating something (`--create`, test accounts only). Learned in 48 seconds. It visited 7 pages, each with a photo. 6 saves were stopped before reaching the site: 1 was a sign-in, sign-up or password form, which isn't listed as an action. The other 5 came from the actions listed.
