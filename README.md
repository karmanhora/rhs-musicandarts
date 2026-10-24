# RHS Music & Arts Attendance

A web-based attendance management platform designed for the music and arts programs at Redmond High School.

🌐 **Website:** [rhsattendance.org](https://rhsattendance.org)

## About

RHS Music & Arts Attendance is a platform designed to simplify attendance tracking for school music and arts events. It provides staff with digital tools to manage attendance while making check-in straightforward for students.

The project aims to make attendance tracking more efficient, organized, and accessible while providing a foundation that can support multiple school programs.

## Features

- **QR Code Check-In** — Students can check in by scanning an event's QR code.
- **Manual Check-In** — An alternative check-in method for students who cannot scan a QR code.
- **Event Attendance Management** — Digital attendance tracking for program events.
- **Authentication** — Secure account access using Supabase Auth and Google sign-in.
- **Role-Based Access** — Different permissions for students and authorized staff.
- **Program-Oriented Design** — Built with the goal of supporting attendance workflows across music and arts programs.

## Tech Stack

- **Frontend:** React and Vite
- **Backend & Database:** Supabase
- **Authentication:** Supabase Auth
- **Hosting:** Vercel
- **Domain:** rhsattendance.org

## Why This Project?

Managing attendance for school events can be time-consuming when relying on manual processes. This project explores how a centralized web application can make check-ins faster and attendance records easier for authorized staff to manage.

It is developed around the needs of a real school community, with an emphasis on usability, maintainability, and responsible handling of student information.

## Development

This repository contains the application's source code and development documentation.

For local setup instructions, see [`docs/DEV.md`](docs/DEV.md).

Before making changes, review [`AGENTS.md`](AGENTS.md) and [`docs/FEATURE_DECISIONS.md`](docs/FEATURE_DECISIONS.md) for project conventions and documented feature decisions.

## Privacy & Security

The application is intended for approved Redmond High School music and arts programs.

- Access to attendance information is governed by application permissions.
- Supabase Row Level Security (RLS) should be maintained for protected database access.
- Do not commit API secrets, service-role keys, credentials, or private student information.
- Review the [Privacy Policy](https://rhsattendance.org/privacy) for the current published policy.

## Project Status

The application is under active development. Features and supported workflows may evolve as the platform develops.

## License

No license has been specified yet. Unless a license is added to this repository, the source code should not be assumed to be available for unrestricted reuse.
