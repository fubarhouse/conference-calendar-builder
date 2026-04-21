# DrupalSouth - Custom Schedule Builder

## 📢 **Disclaimer & Attribution** 📢

> **🙏 Respect & credit 🙏**
>
> This project is a direct copy of [Adam Boros's Vienna Calendar Builder](https://github.com/aboros/drupalcon-vienna-2025-calendar-builder) which is has been adapted for DrupalSouth and related events.
>
> Please make sure you show your gratitude to [Adam Boros](https://www.drupal.org/u/aboros) for the idea and proof of concept in Vienna 2025!

This project has been driven by me, in service of me, and if others find it useful, then I am more than happy for people to use it as they deem fit.
This project is in no way related to or affiliated with the DrupalSouth Steering Committee or any of their sub-committees, and no guarentees are provided for the relevancy of the schedules.

This is a simple _"web application"_ for building personalized schedules for DrupalSouth and related events.  

[See the app in action on GitHub Pages.](https://fubarhouse.github.io/drupalsouth-calendar-builder/)

## Purpose

This project aims to provide a way of storing all of this information in static files in a place where they cannot rot, go missing for any unreasonable reason etc.

This project is deliberately consolidating the information and storing the information long-term so that information which may be disparate or unavailable elsewhere will be still perfectly functional in 50 years assuming the repository exists.

This is why retrospectively, youtube links and Flickr banners are available so that people can enjoy the additional conference content available.

## Features

- **Browse Sessions**: View all DrupalSouth, DrupalSouth Community Day & DrupalGov sessions and events
- **Filter & Search**: Filter by date, track, or search by keywords
- **Select Sessions**: Click to select sessions you want to attend
- **Save Progress**: Your set of selected events is saved automatically to the browser's local storage to continue later
- **Download your schedule as an ICS file**  

## How to Use

1. **Browse**: Use the filters to find sessions by date, track, or keywords
2. **Select**: Click on sessions to add them to your personal schedule
3. **Export**: Use "Download as ICS" to get your schedule as an `.ics` file that can be imported to a calendar application

## Data Source

Session data is sourced from the [official DrupalSouth website](https://drupalsouth.org/events/) and stored in `data/*.json`.

When datasets are added or removed, regenerate the catalog used by the main page and editor:

```bash
node scripts/sync-data-index.mjs
```

Git hooks:

```bash
node scripts/install-git-hooks.mjs
```

This installs a `pre-commit` hook that automatically regenerates and stages `data/index.json` before every commit.

## Privacy

This application is built with privacy in mind:
- No user tracking
- No cookies
- No data collection
- All data stays in your browser
- Uses privacy-first analytics (Simple Analytics)

## Credits

Built with ❤️ by [aboros](https://www.drupal.org/u/aboros) for the Drupal community.

**Notes**:  
- This is an unofficial tool and is not affiliated with [DrupalSouth](https://drupalsouth.org/)
