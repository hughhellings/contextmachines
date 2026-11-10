# `localhost:3000`

_Learned from `http://localhost:3000/` by [Context Machines](https://github.com/hughhellings/contextmachines) on 2026-11-10, from the outside: what a visitor can see and do. Correct anything it got wrong: it's yours, and the next run writes beside your edits, never over them._

## Fix first

Proven: the browser saw or measured each of these.

1. **"Import invoices" does nothing when pressed** (`index.html:73`)

Predicted, not proven: an AI's reading or a plain rule, each resting on words checked to be on the screen or a line checked to be in the code.

2. **Every field, VAT number included, must be filled in before a first client can be saved** (`index.html:86`)

Evidence and what to do about all 2: [FIX.md](FIX.md).

## What it is

Invoice Demo is for people who bill clients: it keeps a client list, creates and sends invoices, exports reports as CSV, and connects online payment.

## The main thing people come to do

**Save invoice**. The product is named and built around invoices, and creating one is what a customer comes to do before sending it.

## Main journeys

- **Add a client:** Dashboard (`/dashboard`) → New client (`/clients/new`)
- **Create an invoice:** Dashboard (`/dashboard`) → Create invoice (`/invoices/new`)
- **Connect online payments:** Dashboard (`/dashboard`) → Get paid online (`/settings/payments`)

## Setup steps it depends on

- **Save invoice** needs **Save client** first: The invoice form asks for a Client, so a client needs to be saved before an invoice can be created for it.

## Parts of the product

| Part | What it's for | How |
| --- | --- | --- |
| Home | Signs a user in to the product. | Enter Email and Password on the Log in page and press Log in. |
| Clients | Adds a client that invoices can be raised against. | On the New client page, fill in Name, Email, Billing address and VAT number, then press Save client. |
| Dashboard | Is the home screen after sign-in, with links to the main work areas. | Press New invoice to start an invoice, or use the links to reach clients, reports and payments. |
| Invoices | Creates an invoice for a client and sends it. | On the Create invoice page, choose a Client, enter Amount and Reg. no., and press Save invoice; on the Invoice page, press Send invoice. |
| Reports | Exports report data as a CSV file. | On the Reports page, press Export CSV. |
| Get paid online | Connects a payment account so that clients can pay invoices online. | On the Get paid online page, enter Account number and press Connect payments. |

## Issues found while exploring

Only what the browser saw for itself: a button that did nothing at all, the site's own script failing, a server error or a failed data request, a link it followed that was broken. An image or file that fails may not show up here.

| Issue | Screen | Evidence |
| --- | --- | --- |
| "Import invoices" does nothing when pressed | `/dashboard` | nothing changed on screen, and no request, navigation or dialog followed |

## Might trip people up (predictions, not proven)

Guessed from the screens and actions, not seen happen: worth a look, unlike the issues above.

| Screen | What | Why |
| --- | --- | --- |
| `/` | Welcome back | The first screen asks people to sign in, and it saw no way to sign up or make an account, so someone new may have no way in. |
| `/invoices/new` | Save invoice | "Save invoice" needs "Save client" done first (the invoice form asks for a Client, so a client needs to be saved before an invoice can be created for it), but the journey "Create an invoice" never passes New client, so people following it may get there too soon. |

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
| Save client | Stores a new client with its name, email, billing address and VAT number so it can be picked on an invoice. | `POST /api/clients` | `/clients/new` |
| Save invoice | Creates an invoice for a chosen client with an amount and registration number. | `POST /api/invoices` | `/invoices/new` |
| Connect payments | Links a payment account so that invoices can be paid online. | `POST /api/payments/connect` | `/settings/payments` |
| Export CSV | Exports the report data as a CSV file. | `POST /api/reports/export` | `/reports` |
| Send invoice | Sends an existing invoice to the client. | `POST /api/invoices/:id/send` | `/invoices/:id` |

---

Not here: screens behind a sign-in it didn't have (`--login`), and ones that only exist after creating something (`--create`, test accounts only). Learned in 52 seconds. It visited 7 pages, each with a photo. 6 saves were stopped before reaching the site: 1 was a sign-in, sign-up or password form, which isn't listed as an action. The other 5 came from the actions listed.
